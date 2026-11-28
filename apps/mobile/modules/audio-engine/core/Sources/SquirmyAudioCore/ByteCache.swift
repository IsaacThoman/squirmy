import Foundation

/// The head of an HTTP response, as the cache needs it.
struct ByteResponse {
  let status: Int
  /// Where the body starts in the stream: 0, or a range's start.
  let start: Int64
  /// The whole stream's length, from `Content-Length` or `Content-Range`.
  let total: Int64?
  let acceptsRanges: Bool
  let contentType: String?
  /// `X-Squirmy-Start-Frame`, for a stream asked for from a time.
  var startFrame: Int64? = nil
}

protocol ByteLoadTask: AnyObject {
  func cancel()
}

/// Receives one request's response, then its body in order, then the end. Calls may come
/// from any thread, but never two at once for one request, and never from inside `load`.
/// `response` returns false to cancel the request.
struct ByteLoadHandler {
  let response: (ByteResponse) -> Bool
  let data: (Data) -> Void
  let complete: (Error?) -> Void
}

/// Fetches bytes of a URL: from `offset` to the end of the stream, or to `end` (exclusive).
/// `URLSessionByteLoader` in the app; tests pass one that serves a fixture.
protocol ByteLoader: AnyObject {
  func load(_ url: URL, from offset: Int64, to end: Int64?, handler: ByteLoadHandler) -> ByteLoadTask
}

/**
 * One stream's bytes in one sparse file, written where they belong, with a map of what has
 * arrived. A sequential download fills it from the start. A read of bytes that are neither
 * there nor about to arrive (the index at the end of an MP4, a trailing tag, the last Ogg
 * page, a seek) fetches that part with a Range request of its own, and waits for it. What
 * plays is what is cached: nothing is fetched twice.
 *
 * Several readers can share one cache (`StreamStore` hands each a `CacheReader`): cancelling
 * a reader wakes only its own reads, and `cancel` stops the download for all of them.
 */
final class ByteCache: ByteSource {
  /// Ranges are fetched to the end of a block of this many bytes, at least `holeMinimum` at a time.
  static let block: Int64 = 64 * 1024
  static let holeMinimum: Int64 = 256 * 1024
  /// A read this close ahead of the sequential download waits for it instead of asking.
  private let nearWindow: Int64
  /// Waits between attempts to resume a download that failed, in seconds. A network that
  /// comes back within about a minute resumes where it stopped.
  static let retryDelays: [Double] = [0.5, 1, 2, 4, 8, 8, 8, 8, 8, 8]

  private let url: URL
  private let loader: ByteLoader
  /// Where the bytes are. Once the stream is whole the file may be moved: reads go on
  /// through the open descriptor.
  let file: URL
  private let descriptor: Int32
  private let onFinish: (Result<Int64, EngineError>) -> Void
  private let condition = NSCondition()
  private let log: (String) -> Void
  private let retryQueue = DispatchQueue(label: "squirmy.audio.cache.retry")

  private var have = RangeSet()
  private var response: ByteResponse?
  private var total: Int64?
  private var acceptsRanges = false
  private var frontier: Int64 = 0
  private var complete = false
  private var failure: Error?
  private var cancelled = false
  private var sequential: ByteLoadTask?
  private var sequentialSerial = 0
  private var retries = 0
  private var holes: [(range: Range<Int64>, task: ByteLoadTask, attempts: Int)] = []

  /// Starts downloading `url` into `file`, which is replaced. `onFinish` is called once, from
  /// the network's queue, when the download has the whole stream (with its length) or has
  /// failed for good; never after `cancel`.
  init(url: URL, loader: ByteLoader, file: URL, nearWindow: Int64 = 256 * 1024, log: @escaping (String) -> Void = { _ in },
       onFinish: @escaping (Result<Int64, EngineError>) -> Void = { _ in }) throws {
    self.url = url
    self.nearWindow = nearWindow
    self.loader = loader
    self.file = file
    self.log = log
    self.onFinish = onFinish
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    descriptor = open(file.path, O_RDWR | O_CREAT | O_TRUNC, 0o644)
    guard descriptor >= 0 else { throw EngineError(message: "Couldn’t create the stream’s cache file (errno \(errno))") }
    condition.lock()
    startSequential(from: 0)
    condition.unlock()
  }

  deinit {
    close(descriptor)
  }

  var isComplete: Bool {
    condition.lock()
    defer { condition.unlock() }
    return complete
  }

  /// The bytes that have arrived, for tests and logs.
  var received: [Range<Int64>] {
    condition.lock()
    defer { condition.unlock() }
    return have.ranges
  }

  /// The download failed for good: reads of what has not arrived will fail.
  var hasFailed: Bool {
    condition.lock()
    defer { condition.unlock() }
    return failure != nil && sequential == nil
  }

  func info() throws -> SourceInfo { try info(for: nil) }
  func length() throws -> Int64 { try length(for: nil) }
  func read(at offset: Int64, count: Int, into buffer: UnsafeMutableRawPointer) throws -> Int {
    try read(at: offset, count: count, into: buffer, for: nil)
  }

  func info(for reader: CacheReader?) throws -> SourceInfo {
    condition.lock()
    defer { condition.unlock() }
    while response == nil {
      try checkUsable(reader)
      condition.wait()
    }
    return SourceInfo(length: total, contentType: response?.contentType, startFrame: response?.startFrame)
  }

  func available(from offset: Int64) -> Int64 {
    condition.lock()
    defer { condition.unlock() }
    return have.end(of: offset) ?? offset
  }

  func length(for reader: CacheReader?) throws -> Int64 {
    condition.lock()
    defer { condition.unlock() }
    while total == nil {
      try checkUsable(reader)
      condition.wait()
    }
    return total!
  }

  func read(at offset: Int64, count: Int, into buffer: UnsafeMutableRawPointer, for reader: CacheReader?) throws -> Int {
    condition.lock()
    defer { condition.unlock() }
    while true {
      if cancelled || reader?.cancelled == true { throw EngineError.cancelled }
      let end: Int64
      if let total {
        if offset >= total { return 0 }
        end = min(total, offset + Int64(count))
      } else {
        end = offset + Int64(count)
      }
      let wanted = offset..<end
      if have.contains(wanted) {
        return try readFile(wanted, into: buffer)
      }
      // A stream of unknown length that has ended: the rest of what was asked does not exist.
      if complete, total == nil || end > total! {
        let available = have.end(of: offset).map { min($0, end) } ?? offset
        return available > offset ? try readFile(offset..<available, into: buffer) : 0
      }
      if let failure, sequential == nil, holes.isEmpty { throw failure }
      requestHole(wanted)
      condition.wait()
    }
  }

  func cancel() {
    condition.lock()
    cancelled = true
    let tasks = [sequential].compactMap { $0 } + holes.map(\.task)
    sequential = nil
    holes.removeAll()
    condition.broadcast()
    condition.unlock()
    tasks.forEach { $0.cancel() }
  }

  /// Cancels and deletes the file.
  func discard() {
    cancel()
    try? FileManager.default.removeItem(at: file)
  }

  /// Wakes `reader`'s waiting reads with `EngineError.cancelled`, as its later reads fail too.
  /// The download goes on for the others.
  func cancel(reader: CacheReader) {
    condition.lock()
    reader.cancelled = true
    condition.broadcast()
    condition.unlock()
  }

  // MARK: - Private, with `condition` locked

  private func checkUsable(_ reader: CacheReader?) throws {
    if cancelled || reader?.cancelled == true { throw EngineError.cancelled }
    if let failure, sequential == nil { throw failure }
  }

  private func readFile(_ range: Range<Int64>, into buffer: UnsafeMutableRawPointer) throws -> Int {
    let count = Int(range.count)
    var done = 0
    while done < count {
      let n = pread(descriptor, buffer + done, count - done, off_t(range.lowerBound) + off_t(done))
      if n <= 0 { throw EngineError(message: "Couldn’t read the stream’s cache file (errno \(errno))") }
      done += n
    }
    return done
  }

  private func write(_ data: Data, at offset: Int64) {
    data.withUnsafeBytes { raw in
      var done = 0
      while done < raw.count {
        let n = pwrite(descriptor, raw.baseAddress! + done, raw.count - done, off_t(offset) + off_t(done))
        if n <= 0 { return }
        done += n
      }
    }
    have.insert(offset..<offset + Int64(data.count))
  }

  private func startSequential(from offset: Int64) {
    sequentialSerial += 1
    let serial = sequentialSerial
    var position = offset
    sequential = loader.load(url, from: offset, to: nil, handler: ByteLoadHandler(
      response: { [weak self] head in
        guard let self else { return false }
        self.condition.lock()
        defer { self.condition.unlock() }
        guard serial == self.sequentialSerial, !self.cancelled else { return false }
        if head.status >= 400 {
          // An answer, not a network failure: asking again would get the same one.
          self.failure = EngineError.http(head.status)
          self.condition.broadcast()
          return false
        }
        self.response = head
        if let total = head.total { self.total = total }
        self.acceptsRanges = head.acceptsRanges || head.status == 206
        // A server that ignored the Range of a resumed download starts again at 0.
        position = head.status == 206 ? head.start : 0
        self.condition.broadcast()
        return true
      },
      data: { [weak self] data in
        guard let self else { return }
        self.condition.lock()
        defer { self.condition.unlock() }
        guard serial == self.sequentialSerial, !self.cancelled else { return }
        self.write(data, at: position)
        position += Int64(data.count)
        self.frontier = position
        self.retries = 0
        self.condition.broadcast()
      },
      complete: { [weak self] error in
        guard let self else { return }
        var outcome: Result<Int64, EngineError>?
        self.condition.lock()
        if serial == self.sequentialSerial, !self.cancelled {
          self.sequential = nil
          if let failure = self.failure {
            // Refused by the server.
            outcome = .failure(EngineError.wrapping(failure))
          } else if let error {
            self.sequentialFailed(EngineError.wrapping(error))
            if let failure = self.failure { outcome = .failure(EngineError.wrapping(failure)) }
          } else {
            self.complete = true
            if self.total == nil { self.total = position }
            self.log("downloaded \(position) bytes")
            outcome = .success(self.total!)
          }
          self.condition.broadcast()
        }
        self.condition.unlock()
        // Outside the lock: whoever hears it may read the cache's state.
        if let outcome { self.onFinish(outcome) }
      }))
  }

  private func sequentialFailed(_ error: EngineError) {
    guard retries < Self.retryDelays.count else {
      failure = error
      log("download failed for good: \(error.message)")
      return
    }
    let delay = Self.retryDelays[retries]
    retries += 1
    log("download stopped at \(frontier) bytes (\(error.message)); resuming in \(delay) s")
    let resumeAt = acceptsRanges ? frontier : 0
    // Readers keep waiting while a retry is due; `sequential` stands for it meanwhile.
    let pending = PendingTask()
    sequential = pending
    retryQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
      guard let self else { return }
      self.condition.lock()
      defer { self.condition.unlock() }
      guard !self.cancelled, self.sequential === pending else { return }
      self.startSequential(from: resumeAt)
    }
  }

  private func requestHole(_ wanted: Range<Int64>) {
    guard acceptsRanges, let total, !complete else { return }
    // From the first byte missing: the start of what was asked may be here already.
    let start = have.end(of: wanted.lowerBound) ?? wanted.lowerBound
    // Close ahead of the download, waiting is quicker than asking.
    if start >= frontier && start < frontier + nearWindow && sequential != nil { return }
    if holes.contains(where: { $0.range.contains(start) }) { return }
    let end = min(total, max((wanted.upperBound + Self.block - 1) / Self.block * Self.block, start + Self.holeMinimum))
    startHole(start..<end, attempts: 0)
  }

  private func startHole(_ range: Range<Int64>, attempts: Int) {
    var position = range.lowerBound
    var ignoredRange = false
    log("fetching bytes \(range.lowerBound)-\(range.upperBound - 1)")
    let task = loader.load(url, from: range.lowerBound, to: range.upperBound, handler: ByteLoadHandler(
      response: { [weak self] head in
        guard let self else { return false }
        self.condition.lock()
        defer { self.condition.unlock() }
        if head.status != 206 || head.start != range.lowerBound {
          // The server would send the whole stream instead: only the download can bring it.
          ignoredRange = true
          self.acceptsRanges = false
          return false
        }
        return true
      },
      data: { [weak self] data in
        guard let self, !ignoredRange else { return }
        self.condition.lock()
        defer { self.condition.unlock() }
        guard !self.cancelled else { return }
        self.write(data, at: position)
        position += Int64(data.count)
        self.condition.broadcast()
      },
      complete: { [weak self] error in
        guard let self else { return }
        self.condition.lock()
        defer { self.condition.unlock() }
        guard let index = self.holes.firstIndex(where: { $0.range == range }) else { return }
        self.holes.remove(at: index)
        if !ignoredRange, error != nil || position < range.upperBound, !self.cancelled {
          if attempts < 3 {
            self.startHole(position..<range.upperBound, attempts: attempts + 1)
          } else if self.sequential == nil {
            self.failure = error.map(EngineError.wrapping) ?? EngineError(message: "The server sent less than asked for")
          }
        }
        self.condition.broadcast()
      }))
    holes.append((range, task, attempts))
  }
}

/// Stands for a download that is due to start again.
private final class PendingTask: ByteLoadTask {
  func cancel() {}
}

/// One reader of a shared `ByteCache`. Cancelling it wakes and fails only its own reads.
final class CacheReader: ByteSource {
  let cache: ByteCache
  /// Guarded by the cache's lock.
  fileprivate(set) var cancelled = false
  /// What the reader belongs to, for `StreamStore`.
  let owner: AnyObject?

  init(cache: ByteCache, owner: AnyObject? = nil) {
    self.cache = cache
    self.owner = owner
  }

  func info() throws -> SourceInfo { try cache.info(for: self) }
  func length() throws -> Int64 { try cache.length(for: self) }
  func read(at offset: Int64, count: Int, into buffer: UnsafeMutableRawPointer) throws -> Int {
    try cache.read(at: offset, count: count, into: buffer, for: self)
  }
  func cancel() { cache.cancel(reader: self) }
  var isComplete: Bool { cache.isComplete }
  func available(from offset: Int64) -> Int64 { cache.available(from: offset) }
}

/**
 * `ByteLoader` on one `URLSession`. Signed stream URLs need no headers. Responses come on
 * the session's own serial queue.
 */
final class URLSessionByteLoader: NSObject, ByteLoader, URLSessionDataDelegate {
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.default
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    configuration.timeoutIntervalForRequest = 30
    configuration.httpMaximumConnectionsPerHost = 6
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.name = "squirmy.audio.network"
    return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }()

  private let lock = NSLock()
  private var handlers: [Int: ByteLoadHandler] = [:]

  func load(_ url: URL, from offset: Int64, to end: Int64?, handler: ByteLoadHandler) -> ByteLoadTask {
    var request = URLRequest(url: url)
    if offset > 0 || end != nil {
      request.setValue("bytes=\(offset)-\(end.map { String($0 - 1) } ?? "")", forHTTPHeaderField: "Range")
    }
    let task = session.dataTask(with: request)
    lock.lock()
    handlers[task.taskIdentifier] = handler
    lock.unlock()
    task.resume()
    return URLSessionLoadTask(task: task)
  }

  private func handler(_ task: URLSessionTask) -> ByteLoadHandler? {
    lock.lock()
    defer { lock.unlock() }
    return handlers[task.taskIdentifier]
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let http = response as? HTTPURLResponse
    let status = http?.statusCode ?? 200
    var start: Int64 = 0
    var total: Int64? = response.expectedContentLength > 0 ? response.expectedContentLength : nil
    if status == 206, let range = http?.value(forHTTPHeaderField: "Content-Range") {
      // "bytes 100-199/1234"
      let parts = range.replacingOccurrences(of: "bytes ", with: "").split(separator: "/")
      start = Int64(parts.first?.split(separator: "-").first ?? "") ?? 0
      total = parts.count > 1 ? Int64(parts[1]) : nil
    }
    let accepts = http?.value(forHTTPHeaderField: "Accept-Ranges")?.lowercased().contains("bytes") ?? false
    let startFrame = http?.value(forHTTPHeaderField: "X-Squirmy-Start-Frame").flatMap { Int64($0) }
    let head = ByteResponse(status: status, start: start, total: total, acceptsRanges: accepts, contentType: http?.mimeType, startFrame: startFrame)
    let keep = handler(dataTask)?.response(head) ?? false
    completionHandler(keep ? .allow : .cancel)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    handler(dataTask)?.data(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    let handler = handlers.removeValue(forKey: task.taskIdentifier)
    lock.unlock()
    if let error = error as? URLError, error.code == .cancelled {
      handler?.complete(EngineError.cancelled)
    } else {
      handler?.complete(error)
    }
  }
}

private final class URLSessionLoadTask: ByteLoadTask {
  let task: URLSessionTask
  init(task: URLSessionTask) { self.task = task }
  func cancel() { task.cancel() }
}
