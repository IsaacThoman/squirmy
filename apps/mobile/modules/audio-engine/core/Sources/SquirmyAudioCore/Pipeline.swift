import Foundation

/// One queue entry as the engine gets it.
struct EngineItem {
  var entryId: String
  var url: URL
  var startMs: Double
  /// Linear; may exceed 1.
  var gain: Float
  /// For a preload: it continues the loaded item's album in album order, so it is never
  /// crossfaded into.
  var albumRun = false
  var decoder: DecoderKind
  /// For `DecoderKind.stream`; the file reader reads a file's own.
  var gapless: Gapless?
  /// Names the stream in the app's streaming cache: a load, the preload and a prefetch with
  /// the same key read one download, whose file the app keeps once it is whole.
  var cacheKey: String?
}

/// Where an item's bytes come from: a file on the device, or the network through a cache file.
protocol SourceFactory: AnyObject {
  func source(for item: EngineItem) throws -> ByteSource
  /// Called when the engine is done with an item's source.
  func discard(_ source: ByteSource)
}

/**
 * One item's decoding: its bytes, its decoder and its PCM at the engine's rate, decoded on
 * the item's own serial queue so that a stream that is slow to arrive holds up nothing else
 * (the next item's server may still be encoding while the current one plays).
 *
 * The feed loop reads the decoded frames (`copy`) and says how far ahead it wants them
 * (`want`). Frames are numbered from the item's start at the engine rate; frames too far
 * behind what was read are dropped (`forget`). All of it is safe from any thread.
 */
final class Pipeline {
  let item: EngineItem
  private let factory: SourceFactory
  private let queue: DispatchQueue
  private let lock = NSLock()
  private let log: (String) -> Void
  private let chunkFrames = 4096

  // Owned by `queue`.
  private var source: ByteSource?
  private var decoder: AudioDecoder?
  private var resampler: Resampler?
  private var engineRate: Double
  private var decodedTo: Int64 = 0

  // Shared, under `lock`.
  private var samples: [Float] = []
  private var base: Int64 = 0
  private var end: Int64 = 0
  private var ended = false
  private var failure: EngineError?
  private var wanted: Int64 = 0
  private var generation = 0
  private var pumping = false
  private var released = false
  private var estimated: Int64?
  private var opened = false
  /// The source, for `release` to cancel from another thread.
  private var cancellable: ByteSource?

  init(item: EngineItem, factory: SourceFactory, engineRate: Double, log: @escaping (String) -> Void) {
    self.item = item
    self.factory = factory
    self.engineRate = engineRate
    self.log = log
    queue = DispatchQueue(label: "squirmy.audio.decode.\(item.entryId)", qos: .userInitiated)
  }

  // MARK: - Read by the feed loop

  /// The first frame not yet decoded, and whether that is the item's end.
  var decoded: (end: Int64, ended: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return (end, ended)
  }

  var error: EngineError? {
    lock.lock()
    defer { lock.unlock() }
    return failure
  }

  /// The item's length at the engine rate once decoded to the end, else the decoder's estimate.
  var lengthFrames: (frames: Int64?, exact: Bool) {
    lock.lock()
    defer { lock.unlock() }
    return ended ? (end, true) : (estimated, false)
  }

  /// True once the decoder is open (the stream's format is known).
  var isOpen: Bool {
    lock.lock()
    defer { lock.unlock() }
    return opened
  }

  /// Up to `count` frames from `frame`, if decoded and kept; empty otherwise.
  func copy(from frame: Int64, count: Int) -> ArraySlice<Float> {
    lock.lock()
    defer { lock.unlock() }
    guard frame >= base, frame < end else { return [] }
    let start = Int(frame - base) * 2
    let stop = start + min(count, Int(end - frame)) * 2
    return samples[start..<stop]
  }

  /// Whether `frame` can be read without a seek: kept, or about to be decoded.
  func holds(_ frame: Int64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return frame >= base && frame <= end
  }

  /// Decodes up to `frame` (or the end), in the background.
  func want(_ frame: Int64) {
    lock.lock()
    wanted = max(wanted, frame)
    let start = !pumping && !released && !ended && failure == nil && end < wanted
    if start { pumping = true }
    lock.unlock()
    if start { queue.async { self.pump() } }
  }

  /// Drops decoded frames before `frame`, which will not be read again.
  func forget(before frame: Int64) {
    lock.lock()
    defer { lock.unlock() }
    let drop = Int(min(max(0, frame - base), end - base))
    // In large steps only: removing from the front copies what is left.
    guard drop >= chunkFrames * 4 else { return }
    samples.removeFirst(drop * 2)
    base += Int64(drop)
  }

  /// Starts decoding again from `frame`, dropping what is kept. Reads see nothing until
  /// frames from there arrive.
  func seek(to frame: Int64, rate: Double? = nil) {
    lock.lock()
    generation += 1
    let serial = generation
    samples.removeAll()
    base = frame
    end = frame
    ended = false
    wanted = frame
    pumping = true
    lock.unlock()
    queue.async {
      self.lock.lock()
      let current = serial == self.generation
      self.lock.unlock()
      // A later seek is queued behind this one and does the work.
      guard current else { return }
      if let rate, rate != self.engineRate {
        self.engineRate = rate
        self.resampler = nil
        self.makeResampler()
      }
      self.decodedTo = frame
      if let decoder = self.decoder {
        do {
          try self.seekDecoder(decoder, to: self.sourceFrame(frame, decoder))
          self.resampler?.reset()
        } catch {
          self.fail(EngineError.wrapping(error), serial)
          return
        }
      }
      self.pump()
    }
  }

  /// Stops decoding and lets the source go. Waiting reads wake and fail.
  func release() {
    lock.lock()
    released = true
    generation += 1
    let source = cancellable
    lock.unlock()
    source?.cancel()
    queue.async {
      if let source = self.source { self.factory.discard(source) }
      self.decoder = nil
      self.source = nil
    }
  }

  /// For tests: waits until decoding has caught up with what is wanted (or is stuck on bytes).
  func settle() {
    queue.sync {}
  }

  // MARK: - On the queue

  private func sourceFrame(_ frame: Int64, _ decoder: AudioDecoder) -> Int64 {
    Int64((Double(frame) * decoder.sampleRate / engineRate).rounded())
  }

  private func open() throws {
    if decoder != nil { return }
    let source = try factory.source(for: item)
    self.source = source
    lock.lock()
    let stillWanted = !released
    cancellable = source
    lock.unlock()
    guard stillWanted else { throw EngineError.cancelled }
    let decoder: AudioDecoder = switch item.decoder {
    case .file: try FileDecoder(source: source)
    case .stream: try StreamDecoder(source: source, gapless: item.gapless, canRestart: canRestart)
    }
    self.decoder = decoder
    makeResampler()
    let start = decodedTo
    if start > 0 { try seekDecoder(decoder, to: sourceFrame(start, decoder)) }
    lock.lock()
    opened = true
    estimated = decoder.estimatedFrames.map { Int64((Double($0) * engineRate / decoder.sampleRate).rounded()) }
    lock.unlock()
    log("\(item.entryId) decoding at \(Int(decoder.sampleRate)) Hz\(resampler == nil ? "" : ", resampled to \(Int(engineRate)) Hz")")
  }

  /// A transcode from the server, which can send it again from a time.
  private var canRestart: Bool { item.decoder == .stream && !item.url.isFileURL }

  /// Seeks the decoder; past what has arrived of a transcode, asks the server for the stream
  /// from that time instead of waiting for it (`start`). That stream is never kept, and the
  /// one it replaces is let go, so a transcode sought through is not cached.
  private func seekDecoder(_ decoder: AudioDecoder, to frame: Int64) throws {
    do {
      try decoder.seek(to: frame)
    } catch is SeekOutsideStream {
      try restart(at: frame, rate: decoder.sampleRate)
    }
  }

  private func restart(at frame: Int64, rate: Double) throws {
    // Milliseconds, to the thousandth: the server rounds them back to exactly this frame. Added
    // to the URL as it is, since `start` is outside the signature and the rest must stay as signed.
    let ms = String(format: "%.3f", Double(frame) / rate * 1000)
    let signed = item.url.absoluteString
    guard let url = URL(string: "\(signed)\(signed.contains("?") ? "&" : "?")start=\(ms)") else { throw EngineError(message: "Couldn’t seek in this stream") }
    var from = item
    from.url = url
    from.cacheKey = nil
    let fresh = try factory.source(for: from)
    let old = source
    source = fresh
    lock.lock()
    let released = self.released
    cancellable = fresh
    lock.unlock()
    if let old { factory.discard(old) }
    guard !released else { throw EngineError.cancelled }
    let decoder = try StreamDecoder(source: fresh, gapless: item.gapless, canRestart: true)
    self.decoder = decoder
    log("\(item.entryId) streaming from \(ms) ms (frame \(decoder.startFrame)), past what had arrived")
    // A stream that begins a frame late (rounding) starts where it begins.
    try decoder.seek(to: max(frame, decoder.startFrame))
  }

  private func makeResampler() {
    guard let decoder else { return }
    resampler = Resampler(from: decoder.sampleRate, to: engineRate)
  }

  private func fail(_ error: EngineError, _ serial: Int) {
    lock.lock()
    if serial == generation, !released {
      failure = error
      log("\(item.entryId) failed: \(error.message)")
    }
    pumping = false
    lock.unlock()
  }

  private func pump() {
    lock.lock()
    let serial = generation
    lock.unlock()
    do {
      try open()
      while true {
        lock.lock()
        let stop = serial != generation || released || ended || end >= wanted
        if stop { pumping = false }
        lock.unlock()
        if stop { return }
        guard let decoder else { return }
        var chunk = try decoder.read(maxFrames: chunkFrames)
        let atEnd = chunk.isEmpty
        if let resampler { chunk = atEnd ? resampler.finish() : resampler.process(chunk) }
        lock.lock()
        if serial == generation {
          samples += chunk
          end += Int64(chunk.count / 2)
          decodedTo = end
          if atEnd { ended = true }
        }
        lock.unlock()
      }
    } catch {
      fail(EngineError.wrapping(error), serial)
    }
  }
}
