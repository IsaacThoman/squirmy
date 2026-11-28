import AVFoundation
import Foundation

/**
 * The process's one engine, made on first use and owned by no view or JavaScript object, so
 * it outlives a JavaScript reload and is the same object whichever scene drives it (the
 * phone's, or CarPlay's when the car connects first). Events go to every module instance on
 * the main queue.
 */
final class SharedEngine {
  static let shared = SharedEngine()

  /// Posted on the main queue with `elapsed` (seconds) and `rate` whenever they change other
  /// than by playing on: `NowPlayingModule` writes them to the lock screen without waiting
  /// for JavaScript.
  static let clockNotification = Notification.Name("SquirmyAudioClockDidChange")

  private let lock = NSLock()
  private var listeners: [UUID: (EngineEvent) -> Void] = [:]
  private var made: Engine?
  private var session: AudioSessionController?

  /// The engine, made now if it is the first time.
  var engine: Engine {
    lock.lock()
    defer { lock.unlock() }
    if let made { return made }
    let queue = DispatchQueue(label: "squirmy.audio.feed", qos: .userInteractive)
    let rate = AVAudioSession.sharedInstance().sampleRate
    let output = RendererOutput(sampleRate: rate > 0 ? rate : 48_000, queue: queue)
    let engine = Engine(output: output, factory: NetworkSources { [weak self] message in self?.dispatch(.log(message)) }, queue: queue)
    engine.listener = { [weak self] event in self?.dispatch(event) }
    session = AudioSessionController(engine: engine) { [weak self] message in self?.dispatch(.log(message)) }
    engine.session = session
    made = engine
    return engine
  }

  func addListener(_ listener: @escaping (EngineEvent) -> Void) -> UUID {
    let id = UUID()
    lock.lock()
    listeners[id] = listener
    lock.unlock()
    return id
  }

  func removeListener(_ id: UUID) {
    lock.lock()
    listeners.removeValue(forKey: id)
    lock.unlock()
  }

  private func dispatch(_ event: EngineEvent) {
    lock.lock()
    let all = Array(listeners.values)
    lock.unlock()
    DispatchQueue.main.async {
      if case .status(let status) = event, status.entryId != nil {
        NotificationCenter.default.post(name: Self.clockNotification, object: nil, userInfo: [
          "elapsed": status.positionMs / 1000,
          "rate": status.state == .playing ? 1.0 : 0.0,
        ])
      }
      all.forEach { $0(event) }
    }
  }
}

/**
 * Where an item's bytes come from: a file on the device (a download) as it is, or the network
 * through a cache file in `Caches/squirmy-engine`, deleted once the engine is done with it.
 * Keeping those files as the streaming cache is the next step.
 */
final class NetworkSources: SourceFactory {
  private let loader = URLSessionByteLoader()
  private let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("squirmy-engine", isDirectory: true)
  private let log: (String) -> Void

  init(log: @escaping (String) -> Void) {
    self.log = log
    // Files of an earlier run that ended before it could delete them.
    try? FileManager.default.removeItem(at: directory)
  }

  func source(for item: EngineItem) throws -> ByteSource {
    if item.url.isFileURL { return try FileByteSource(url: item.url) }
    let entryId = item.entryId
    let log = log
    return try ByteCache(url: item.url, loader: loader, file: directory.appendingPathComponent(UUID().uuidString)) { message in log("\(entryId) \(message)") }
  }

  func discard(_ source: ByteSource) {
    if let cache = source as? ByteCache { cache.discard() } else { source.cancel() }
  }
}
