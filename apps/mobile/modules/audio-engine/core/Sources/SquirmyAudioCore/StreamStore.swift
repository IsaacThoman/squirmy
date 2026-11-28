import Foundation

/// What became of a stream downloaded under a cache key.
enum CacheReport: Equatable {
  /// The whole stream is in `file`, which now belongs to the app: the engine neither moves nor
  /// deletes it, and goes on reading it through its open descriptor wherever it is moved.
  case complete(cacheKey: String, file: URL, bytes: Int64)
  /// The stream was given up before it was whole (skipped, cancelled, or it failed for good),
  /// and its file is deleted once nothing reads it.
  case dropped(cacheKey: String, message: String)
}

/**
 * Where items' bytes come from: a file on the device (a download or a cached file) as it is,
 * or the network through a `ByteCache` in `directory`.
 *
 * A stream with a cache key is downloaded once, however many ask for it: the loaded item,
 * the preload (the same track twice in a row) and a prefetch (`prefetch`) all read the same
 * cache. When its download has the whole stream the file is reported (`complete`) and is the
 * app's from then on; the streaming cache keeps it. One that nothing reads or prefetches any
 * more before then is cancelled and deleted (`dropped`), so a song skipped half way is not
 * kept. A stream without a key is deleted once the engine is done with it.
 */
final class StreamStore: SourceFactory {
  private final class Stream {
    let key: String
    var cache: ByteCache?
    var readers = 0
    var prefetched = false
    init(key: String) { self.key = key }
  }

  private let loader: ByteLoader
  private let directory: URL
  private let nearWindow: Int64
  private let log: (String) -> Void
  private let report: (CacheReport) -> Void
  private let lock = NSLock()
  /// Streams still downloading, by key. A whole one leaves at once, so a later request for the
  /// key starts afresh (the app plays the file it was given instead).
  private var streams: [String: Stream] = [:]

  /// `report` is called from any thread, never with the store's lock held.
  init(loader: ByteLoader, directory: URL, nearWindow: Int64 = 256 * 1024, log: @escaping (String) -> Void = { _ in },
       report: @escaping (CacheReport) -> Void = { _ in }) {
    self.loader = loader
    self.directory = directory
    self.nearWindow = nearWindow
    self.log = log
    self.report = report
  }

  func source(for item: EngineItem) throws -> ByteSource {
    if item.url.isFileURL { return try FileByteSource(url: item.url) }
    let entryId = item.entryId
    guard let key = item.cacheKey else {
      return try ByteCache(url: item.url, loader: loader, file: newFile(), nearWindow: nearWindow, log: { [log] in log("\(entryId) \($0)") })
    }
    lock.lock()
    defer { lock.unlock() }
    if let stream = streams[key], let cache = stream.cache, !cache.hasFailed {
      stream.readers += 1
      log("\(entryId) reads \(key), already downloading")
      return CacheReader(cache: cache, owner: stream)
    }
    let stream = try start(key: key, url: item.url, log: { [log] in log("\(entryId) \($0)") })
    stream.readers = 1
    return CacheReader(cache: stream.cache!, owner: stream)
  }

  func discard(_ source: ByteSource) {
    guard let reader = source as? CacheReader, let stream = reader.owner as? Stream else {
      if let cache = source as? ByteCache { cache.discard() } else { source.cancel() }
      return
    }
    reader.cancel()
    lock.lock()
    stream.readers -= 1
    let abandoned = stream.readers == 0 && !stream.prefetched && streams[stream.key] === stream
    if abandoned { streams.removeValue(forKey: stream.key) }
    let idle = stream.readers == 0 && !stream.prefetched
    lock.unlock()
    guard idle, let cache = stream.cache else { return }
    // A whole stream's file is the app's now; any other goes.
    if cache.isComplete { cache.cancel() } else { cache.discard() }
    if abandoned { report(.dropped(cacheKey: stream.key, message: "Stopped before it was whole")) }
  }

  /// Downloads `url` under `key` without playing it, unless it is downloading already. An item
  /// loaded with the same key reads the same download.
  func prefetch(cacheKey key: String, url: URL) {
    lock.lock()
    if let stream = streams[key], let cache = stream.cache, !cache.hasFailed {
      stream.prefetched = true
      lock.unlock()
      return
    }
    do {
      let stream = try start(key: key, url: url, log: { [log] in log("prefetch \($0)") })
      stream.prefetched = true
      lock.unlock()
    } catch {
      lock.unlock()
      report(.dropped(cacheKey: key, message: EngineError.wrapping(error).message))
    }
  }

  /// Stops a prefetch. Its download goes on while an item reads it.
  func cancelPrefetch(cacheKey key: String) {
    lock.lock()
    guard let stream = streams[key], stream.prefetched else { return lock.unlock() }
    stream.prefetched = false
    let idle = stream.readers == 0
    if idle { streams.removeValue(forKey: key) }
    lock.unlock()
    guard idle else { return }
    stream.cache?.discard()
    report(.dropped(cacheKey: key, message: "Cancelled"))
  }

  /// Streams still downloading under a key, for tests and logs.
  var downloading: [String] {
    lock.lock()
    defer { lock.unlock() }
    return streams.keys.sorted()
  }

  // MARK: - Private

  private func newFile() -> URL {
    directory.appendingPathComponent(UUID().uuidString)
  }

  /// A new stream for `key`, downloading. With the lock held.
  private func start(key: String, url: URL, log: @escaping (String) -> Void) throws -> Stream {
    let stream = Stream(key: key)
    stream.cache = try ByteCache(url: url, loader: loader, file: newFile(), nearWindow: nearWindow, log: log) { [weak self, weak stream] outcome in
      guard let self, let stream else { return }
      self.finished(stream, outcome)
    }
    streams[key] = stream
    log("downloading \(key)")
    return stream
  }

  private func finished(_ stream: Stream, _ outcome: Result<Int64, EngineError>) {
    lock.lock()
    let current = streams[stream.key] === stream
    if current { streams.removeValue(forKey: stream.key) }
    let idle = stream.readers == 0 && !stream.prefetched
    lock.unlock()
    // Cancelled or abandoned meanwhile: said already.
    guard current, let cache = stream.cache else { return }
    switch outcome {
    case .success(let bytes):
      report(.complete(cacheKey: stream.key, file: cache.file, bytes: bytes))
    case .failure(let error):
      // What arrived still plays; the file goes with the last reader.
      if idle { cache.discard() }
      report(.dropped(cacheKey: stream.key, message: error.message))
    }
  }
}
