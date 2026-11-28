import AVFoundation
import CoreMedia

/// What the output reports by itself.
enum OutputEvent {
  /// It threw away what was queued from `frame` on (a route or rate change did it).
  case flushedAutomatically(at: Int64)
  /// Its output format changed, such as the route's sample rate.
  case configurationChanged
}

/// Already rendered stereo PCM on the output timeline.
struct OutputChunk {
  let start: Int64
  let samples: ArraySlice<Float>
  var end: Int64 { start + Int64(samples.count / 2) }

  func slice(from: Int64, to: Int64) -> ArraySlice<Float> {
    let lower = samples.startIndex + Int(max(from, start) - start) * 2
    let upper = samples.startIndex + Int(min(to, end) - start) * 2
    return samples[lower..<upper]
  }
}

/// Retains the queued music so a transport command can reuse its actual output (including
/// gain, ramps and DSP) without asking a decoder to render it again.
struct QueuedAudio {
  private var chunks: [OutputChunk] = []

  mutating func append(_ samples: ArraySlice<Float>, at frame: Int64) {
    chunks.append(OutputChunk(start: frame, samples: samples))
  }

  mutating func forget(before frame: Int64) {
    chunks.removeAll { $0.end <= frame }
  }

  mutating func discard(from frame: Int64) {
    chunks.removeAll { $0.start >= frame }
    if let last = chunks.last, last.end > frame {
      chunks[chunks.count - 1] = OutputChunk(start: last.start, samples: last.slice(from: last.start, to: frame))
    }
  }

  mutating func reset() { chunks.removeAll(keepingCapacity: true) }

  func fadeOut(from start: Int64, to end: Int64) -> OutputChunk? {
    var samples: [Float] = []
    var frame = start
    for chunk in chunks where chunk.end > frame {
      guard chunk.start <= frame, frame < end else { break }
      samples += chunk.slice(from: frame, to: end)
      frame = min(chunk.end, end)
    }
    let count = samples.count / 2
    guard count > 0 else { return nil }
    for index in 0..<count {
      let gain = Float(count - 1 - index) / Float(max(1, count - 1))
      samples[index * 2] *= gain
      samples[index * 2 + 1] *= gain
    }
    return OutputChunk(start: start, samples: samples[...])
  }
}

/**
 * Where the PCM goes, on one clock counted in frames at `sampleRate`. `RendererOutput` in the
 * app; tests use one with a clock they move. Used from the feed queue only.
 */
protocol AudioOutput: AnyObject {
  var sampleRate: Double { get set }
  /// The frame being heard now.
  func currentFrame() -> Double
  /// 0 or 1. Its clock runs only at 1.
  var rate: Float { get }
  /// Sets the clock to `frame` and the rate, at once.
  func setRate(_ rate: Float, at frame: Int64)
  /// Queues interleaved stereo frames to play from `frame`.
  func enqueue(_ samples: ArraySlice<Float>, at frame: Int64)
  /// Throws away everything queued.
  func flush()
  var isReadyForMoreMediaData: Bool { get }
  /// Failed beyond repair; `rebuild` makes it new.
  var failure: Error? { get }
  func rebuild()
  var onEvent: ((OutputEvent) -> Void)? { get set }
}

/**
 * The system output: one `AVSampleBufferAudioRenderer` on an
 * `AVSampleBufferRenderSynchronizer`. Unlike `AVAudioEngine` it takes AirPlay 2's buffered
 * path, and nothing of ours runs on a real-time thread: the renderer pulls from what we
 * queue. Its clock keeps going when it runs dry, so the engine stops it on an underrun.
 */
final class RendererOutput: AudioOutput {
  private(set) var renderer = AVSampleBufferAudioRenderer()
  private(set) var synchronizer = AVSampleBufferRenderSynchronizer()
  var sampleRate: Double {
    didSet { format = Self.makeFormat(sampleRate) }
  }
  var onEvent: ((OutputEvent) -> Void)?
  private var format: CMAudioFormatDescription?
  private var observers: [NSObjectProtocol] = []
  private let queue: DispatchQueue

  /// `queue` is the feed queue, where events are delivered.
  init(sampleRate: Double, queue: DispatchQueue) {
    self.sampleRate = sampleRate
    self.queue = queue
    format = Self.makeFormat(sampleRate)
    attach()
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }

  private func attach() {
    synchronizer.addRenderer(renderer)
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: .AVSampleBufferAudioRendererWasFlushedAutomatically, object: renderer, queue: nil) { [weak self] note in
        let time = (note.userInfo?[AVSampleBufferAudioRendererFlushTimeKey] as? NSValue)?.timeValue ?? .invalid
        self?.queue.async {
          guard let self else { return }
          let frame = time.isValid ? Int64((time.seconds * self.sampleRate).rounded()) : Int64(self.currentFrame())
          self.onEvent?(.flushedAutomatically(at: frame))
        }
      },
      center.addObserver(forName: .AVSampleBufferAudioRendererOutputConfigurationDidChange, object: renderer, queue: nil) { [weak self] _ in
        self?.queue.async { self?.onEvent?(.configurationChanged) }
      },
    ]
  }

  func currentFrame() -> Double {
    synchronizer.currentTime().seconds * sampleRate
  }

  var rate: Float { synchronizer.rate }

  func setRate(_ rate: Float, at frame: Int64) {
    synchronizer.setRate(rate, time: CMTime(value: frame, timescale: CMTimeScale(sampleRate)))
  }

  var isReadyForMoreMediaData: Bool { renderer.isReadyForMoreMediaData }

  var failure: Error? { renderer.status == .failed ? (renderer.error ?? EngineError(message: "The audio output failed")) : nil }

  func enqueue(_ samples: ArraySlice<Float>, at frame: Int64) {
    guard let format, !samples.isEmpty else { return }
    let frames = samples.count / 2
    let bytes = samples.count * 4
    var block: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil, customBlockSource: nil,
                                             offsetToData: 0, dataLength: bytes, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block) == noErr,
          let block else { return }
    samples.withUnsafeBytes { _ = CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes) }
    var sample: CMSampleBuffer?
    let time = CMTime(value: frame, timescale: CMTimeScale(sampleRate))
    guard CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: format, sampleCount: frames,
                                                               presentationTimeStamp: time, packetDescriptions: nil, sampleBufferOut: &sample) == noErr,
          let sample else { return }
    renderer.enqueue(sample)
  }

  func flush() {
    renderer.flush()
  }

  /// After the media services were reset, or the renderer failed: a new renderer and clock.
  func rebuild() {
    synchronizer.removeRenderer(renderer, at: .zero)
    renderer = AVSampleBufferAudioRenderer()
    synchronizer = AVSampleBufferRenderSynchronizer()
    attach()
  }

  private static func makeFormat(_ rate: Double) -> CMAudioFormatDescription? {
    var description = PCM.format(rate: rate)
    var format: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format)
    return format
  }
}
