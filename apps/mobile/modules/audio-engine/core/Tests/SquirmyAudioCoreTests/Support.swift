import Accelerate
import Foundation
@testable import SquirmyAudioCore

/// The split-tone fixtures from `scripts/make-fixtures.mts`: a sweep cut at `splitFrame`.
enum Fixtures {
  static let splitFrame = 58_211
  static let rate = 44_100.0

  static func url(_ name: String) -> URL {
    Bundle.module.resourceURL!.appendingPathComponent("Fixtures").appendingPathComponent(name)
  }

  /// The halves of one encoding, such as `flac` or `aac_256`.
  static func pair(_ encoding: String, _ ext: String) -> (a: URL, b: URL) {
    (url("\(encoding).a.\(ext)"), url("\(encoding).b.\(ext)"))
  }

  /// The uncut sweep, decoded.
  static let reference: [Float] = decodeFile(url("ref.flac"))
}

/// Every frame a decoder gives, interleaved stereo.
func decodeAll(_ decoder: AudioDecoder) throws -> [Float] {
  var out: [Float] = []
  while true {
    let chunk = try decoder.read(maxFrames: 4096)
    if chunk.isEmpty { return out }
    out += chunk
  }
}

func decodeFile(_ url: URL, kind: DecoderKind = .file, gapless: Gapless? = nil) -> [Float] {
  do {
    let source = try FileByteSource(url: url)
    let decoder: AudioDecoder = kind == .file ? try FileDecoder(source: source) : try StreamDecoder(source: source, gapless: gapless)
    return try decodeAll(decoder)
  } catch {
    fatalError("\(url.lastPathComponent) (\(kind)): \(error)")
  }
}

/// One channel of interleaved stereo.
func channel(_ samples: [Float], _ index: Int) -> [Float] {
  stride(from: index, to: samples.count, by: 2).map { samples[$0] }
}

/// The reference at another rate, through the engine's own resampler.
func resampled(_ samples: [Float], to rate: Double) -> [Float] {
  guard let resampler = Resampler(from: Fixtures.rate, to: rate) else { return samples }
  return resampler.process(samples) + resampler.finish()
}

/// The lag (within ±`maxLag`) at which `x` around `start` best matches `ref` around `refStart`.
func bestLag(_ x: [Float], _ ref: [Float], refStart: Int, start: Int, window: Int = 4096, maxLag: Int = 3000) -> Int {
  var best = (lag: 0, corr: -Float.infinity)
  let r = Array(ref[refStart..<refStart + window])
  var rr: Float = 0
  vDSP_dotpr(r, 1, r, 1, &rr, vDSP_Length(window))
  x.withUnsafeBufferPointer { p in
    for lag in -maxLag...maxLag {
      let s = start + lag
      if s < 0 || s + window > x.count { continue }
      var xy: Float = 0
      var xx: Float = 0
      vDSP_dotpr(p.baseAddress! + s, 1, r, 1, &xy, vDSP_Length(window))
      vDSP_dotpr(p.baseAddress! + s, 1, p.baseAddress! + s, 1, &xx, vDSP_Length(window))
      let c = xy / max(sqrt(xx * rr), 1e-20)
      if c > best.corr { best = (lag, c) }
    }
  }
  return best.lag
}

/// How many samples two consecutive decoded halves add (positive) or lose (negative) at
/// their boundary, against the uncut reference at the same rate: 0 is gapless.
func boundaryGap(a: [Float], b: [Float], reference: [Float], split: Int) -> Int {
  let left = channel(reference, 0)
  let aLeft = channel(a, 0)
  let bLeft = channel(b, 0)
  // Where A's start sits, and where B's start sits against where it belongs.
  let aLag = bestLag(aLeft, left, refStart: 8192, start: 8192)
  let bLag = bestLag(bLeft, left, refStart: split + 8192, start: 8192)
  let tail = aLeft.count - (split + aLag)
  return tail + bLag
}

/// The frame of `heard` where `item` starts, after the silence a played load starts with.
func start(of item: [Float], in heard: [Float]) -> Int? {
  let probe = item.prefix(4096)
  for frame in 0..<max(0, min(20_000, heard.count / 2 - 2048)) where heard[frame * 2..<frame * 2 + 4096].elementsEqual(probe) {
    return frame
  }
  return nil
}

/// The largest difference between two runs of samples, over their common length.
func maxDifference(_ x: ArraySlice<Float>, _ y: ArraySlice<Float>) -> Float {
  var worst: Float = 0
  for (a, b) in zip(x, y) { worst = max(worst, abs(a - b)) }
  return worst
}

// MARK: - Sources

/// Files by URL; a `GatedSource` for URLs the test holds back.
final class TestFactory: SourceFactory {
  var gates: [URL: GatedSource] = [:]
  var failing: Set<URL> = []
  private(set) var discarded = 0

  func source(for item: EngineItem) throws -> ByteSource {
    if failing.contains(item.url) { throw EngineError(message: "The server answered HTTP 404") }
    if let gate = gates[item.url] { return gate }
    return try FileByteSource(url: item.url)
  }

  func discard(_ source: ByteSource) { discarded += 1 }
}

/// A file whose bytes arrive only up to `allowed`: reads past it wait, as for a stalled network.
final class GatedSource: ByteSource {
  private let file: FileByteSource
  private let size: Int64
  private let condition = NSCondition()
  private var allowed: Int64
  private let tail: Int64
  private var cancelled = false
  private(set) var waiting = false

  /// The first `allowed` bytes are there, and the last `tail`.
  init(url: URL, allowed: Int64, tail: Int64 = 0) throws {
    file = try FileByteSource(url: url)
    size = try file.length()
    self.allowed = allowed
    self.tail = tail
  }

  func allow(_ bytes: Int64) {
    condition.lock()
    allowed = bytes
    condition.broadcast()
    condition.unlock()
  }

  var isWaiting: Bool {
    condition.lock()
    defer { condition.unlock() }
    return waiting
  }

  func info() throws -> SourceInfo { try file.info() }
  func length() throws -> Int64 { size }
  var isComplete: Bool { false }

  func read(at offset: Int64, count: Int, into buffer: UnsafeMutableRawPointer) throws -> Int {
    condition.lock()
    while !cancelled, min(size, offset + Int64(count)) > allowed, offset < size - tail {
      waiting = true
      condition.wait()
    }
    waiting = false
    let cancelled = self.cancelled
    condition.unlock()
    if cancelled { throw EngineError.cancelled }
    return try file.read(at: offset, count: count, into: buffer)
  }

  func cancel() {
    condition.lock()
    cancelled = true
    condition.broadcast()
    condition.unlock()
  }
}

/// Serves bytes as a server would: optionally slowly, with or without Range and a length,
/// and failing once part way when asked. Responses come on a queue of its own.
final class FakeLoader: ByteLoader {
  let data: Data
  var chunk = 16 * 1024
  var delay: TimeInterval = 0
  var ranges = true
  var sendsLength = true
  var status = 200
  /// The first sequential download stops with a network error at this byte.
  var failAt: Int64?
  private let lock = NSLock()
  private var log: [(from: Int64, to: Int64?)] = []

  init(data: Data) { self.data = data }

  var requests: [(from: Int64, to: Int64?)] {
    lock.lock()
    defer { lock.unlock() }
    return log
  }

  func load(_ url: URL, from offset: Int64, to end: Int64?, handler: ByteLoadHandler) -> ByteLoadTask {
    let task = FakeTask()
    lock.lock()
    log.append((offset, end))
    lock.unlock()
    let total = Int64(data.count)
    let ranged = ranges && (offset > 0 || end != nil)
    let start = ranged ? offset : 0
    let stop = ranged ? min(total, end ?? total) : total
    let failure = failAt
    if offset == 0 && end == nil { failAt = nil }
    // Each request on its own queue, as concurrent connections are.
    DispatchQueue(label: "fake.loader.\(offset)").async { [self] in
      guard !task.cancelled else { return handler.complete(EngineError.cancelled) }
      let head = ByteResponse(status: status == 200 && ranged ? 206 : status, start: start, total: sendsLength || ranged ? total : nil,
                              acceptsRanges: ranges, contentType: mimeType(forExtension: url.pathExtension))
      guard handler.response(head) else { return handler.complete(EngineError.cancelled) }
      var position = start
      while position < stop {
        if delay > 0 { Thread.sleep(forTimeInterval: delay) }
        if task.cancelled { return handler.complete(EngineError.cancelled) }
        if let failure, offset == 0, end == nil, position >= failure {
          return handler.complete(URLError(.networkConnectionLost))
        }
        let next = min(stop, position + Int64(chunk))
        handler.data(data.subdata(in: Int(position)..<Int(next)))
        position = next
      }
      handler.complete(nil)
    }
    return task
  }
}

final class FakeTask: ByteLoadTask {
  private let lock = NSLock()
  private var flag = false
  var cancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return flag
  }
  func cancel() {
    lock.lock()
    flag = true
    lock.unlock()
  }
}

// MARK: - Output

/**
 * An output with a clock the test moves. It plays what was queued as its clock passes over
 * it, records what was heard, and counts frames the clock ran over with nothing queued
 * (`starved`), which a real renderer would have skipped.
 */
final class FakeOutput: AudioOutput {
  var sampleRate: Double
  var onEvent: ((OutputEvent) -> Void)?
  private(set) var rate: Float = 0
  private var time: Int64 = 0
  private var queued: [(frame: Int64, samples: [Float])] = []
  /// Everything heard, in order, with the timeline frame it was heard at.
  private(set) var heard: [Float] = []
  private(set) var heardFrom: Int64?
  private(set) var starved = 0
  var failure: Error?
  private(set) var rebuilt = 0

  init(sampleRate: Double) { self.sampleRate = sampleRate }

  func currentFrame() -> Double { Double(time) }

  func setRate(_ rate: Float, at frame: Int64) {
    self.rate = rate
    time = frame
  }

  /// The end of what is queued, as a timeline frame.
  var queuedEnd: Int64 { queued.last.map { $0.frame + Int64($0.samples.count / 2) } ?? time }

  func enqueue(_ samples: ArraySlice<Float>, at frame: Int64) {
    queued.append((frame, Array(samples)))
  }

  func flush() { queued.removeAll() }
  var isReadyForMoreMediaData: Bool { true }
  func rebuild() {
    rebuilt += 1
    failure = nil
    queued.removeAll()
    rate = 0
  }

  /// Moves the clock on by `frames` while it runs, hearing what is queued for that time.
  func advance(_ frames: Int) {
    guard rate > 0 else { return }
    for _ in 0..<frames {
      while let first = queued.first, first.frame + Int64(first.samples.count / 2) <= time { queued.removeFirst() }
      if let first = queued.first, first.frame <= time {
        let index = Int(time - first.frame) * 2
        if heardFrom == nil { heardFrom = time }
        heard.append(first.samples[index])
        heard.append(first.samples[index + 1])
      } else {
        starved += 1
      }
      time += 1
    }
  }

  func resetHearing() {
    heard.removeAll()
    heardFrom = nil
    starved = 0
  }
}

/// Several streams by the last part of their URL, each from its own `FakeLoader`, as one server.
final class FakeServer: ByteLoader {
  private(set) var files: [String: FakeLoader] = [:]

  /// Serves `file` at every URL that ends in `name`, whatever its query.
  func serve(_ name: String, _ file: URL) throws -> FakeLoader {
    let loader = FakeLoader(data: try Data(contentsOf: file))
    files[name] = loader
    return loader
  }

  func load(_ url: URL, from offset: Int64, to end: Int64?, handler: ByteLoadHandler) -> ByteLoadTask {
    guard let loader = files[url.lastPathComponent] else {
      let task = FakeTask()
      DispatchQueue.global().async {
        _ = handler.response(ByteResponse(status: 404, start: 0, total: nil, acceptsRanges: false, contentType: nil))
        handler.complete(EngineError.cancelled)
      }
      return task
    }
    return loader.load(url, from: offset, to: end, handler: handler)
  }
}

/// What a `StreamStore` reported, from whichever thread it said it.
final class ReportLog {
  private let condition = NSCondition()
  private var reports: [CacheReport] = []

  func add(_ report: CacheReport) {
    condition.lock()
    reports.append(report)
    condition.broadcast()
    condition.unlock()
  }

  var all: [CacheReport] {
    condition.lock()
    defer { condition.unlock() }
    return reports
  }

  /// Waits up to `timeout` seconds for `count` reports, and gives what there is.
  func wait(for count: Int, timeout: TimeInterval = 5) -> [CacheReport] {
    let deadline = Date().addingTimeInterval(timeout)
    condition.lock()
    defer { condition.unlock() }
    while reports.count < count, condition.wait(until: deadline) {}
    return reports
  }
}

/// An engine on a `FakeOutput`, stepped by hand.
final class Harness {
  let output: FakeOutput
  let factory = TestFactory()
  let engine: Engine
  private let lock = NSLock()
  private var recorded: [EngineEvent] = []
  /// Called on the feed queue with each event, before it is recorded.
  var onEvent: ((EngineEvent) -> Void)?

  /// `sources` replaces the fixture files of `factory`, such as a `StreamStore` on a fake server.
  init(rate: Double = Fixtures.rate, fadeIn: Double = 0, sources: SourceFactory? = nil) {
    output = FakeOutput(sampleRate: rate)
    var config = EngineConfig()
    config.manualTicks = true
    config.fadeIn = fadeIn
    engine = Engine(output: output, factory: sources ?? factory, config: config)
    engine.listener = { [weak self] event in
      guard let self else { return }
      self.onEvent?(event)
      if case .log = event { return }
      self.lock.lock()
      self.recorded.append(event)
      self.lock.unlock()
    }
  }

  var events: [EngineEvent] {
    lock.lock()
    defer { lock.unlock() }
    return recorded
  }

  func clearEvents() {
    lock.lock()
    recorded.removeAll()
    lock.unlock()
  }

  var ended: [String] {
    events.compactMap { if case .ended(let id) = $0 { return id } else { return nil } }
  }

  func item(_ id: String, _ url: URL, startMs: Double = 0, gain: Float = 1, decoder: DecoderKind = .file, cacheKey: String? = nil) -> EngineItem {
    EngineItem(entryId: id, url: url, startMs: startMs, gain: gain, decoder: decoder, gapless: nil, cacheKey: cacheKey)
  }

  /// Waits for the queued commands, then for the decoders.
  func settle() {
    engine.tickNow()
    engine.settle()
    engine.tickNow()
  }

  /// Runs the clock for `seconds` in 20 ms steps, letting the decoders catch up after each.
  /// `between` runs after each step.
  func run(seconds: Double, decoders: Bool = true, between: (() -> Void)? = nil) {
    let step = Int(output.sampleRate * 0.02)
    for _ in 0..<Int(seconds / 0.02) {
      engine.queue.sync { output.advance(step) }
      engine.tickNow()
      if decoders { engine.settle() }
      between?()
    }
  }

  var status: EngineStatus { engine.status() }
}
