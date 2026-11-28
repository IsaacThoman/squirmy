import XCTest
@testable import SquirmyAudioCore

/// One download per stream, handed to the app once whole: what the streaming cache keeps.
final class StreamStoreTests: XCTestCase {
  private var directory: URL!
  private let reports = ReportLog()
  private let server = FakeServer()

  override func setUp() {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("squirmy-store-tests-\(UUID().uuidString)")
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
  }

  private func makeStore() -> StreamStore {
    StreamStore(loader: server, directory: directory, nearWindow: 16 * 1024, report: { [reports] in reports.add($0) })
  }

  /// A signed URL of the stream: each one signs it anew, with another expiry.
  private func url(_ name: String, _ signature: Int = 1) -> URL {
    URL(string: "https://music.example/api/v1/stream/\(name)?sig=\(signature)")!
  }

  private func item(_ name: String, signature: Int = 1, key: String? = nil) -> EngineItem {
    EngineItem(entryId: name, url: url(name, signature), startMs: 0, gain: 1, decoder: .file, gapless: nil, cacheKey: key)
  }

  private func files() -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
  }

  func testAPrefetchAndALoadOfTheSameStreamShareOneDownload() throws {
    let fixture = Fixtures.pair("flac", "flac").b
    let loader = try server.serve("b", fixture)
    loader.delay = 0.002
    let store = makeStore()
    store.prefetch(cacheKey: "b:original", url: url("b", 1))
    // The player resolved the same stream on its own, with a URL signed later.
    let source = try store.source(for: item("b", signature: 2, key: "b:original"))
    XCTAssertEqual(try decodeAll(try FileDecoder(source: source)), decodeFile(fixture))
    store.discard(source)

    guard case .complete(let key, let file, let bytes) = reports.wait(for: 1).first else { return XCTFail("no file: \(reports.all)") }
    XCTAssertEqual(key, "b:original")
    XCTAssertEqual(loader.requests.count, 1, "fetched more than once: \(loader.requests)")
    XCTAssertEqual(bytes, Int64(loader.data.count))
    // The file is the app's now: still there once nothing reads it.
    XCTAssertEqual(try Data(contentsOf: file), loader.data)
    XCTAssertEqual(store.downloading, [])
  }

  func testAStreamLetGoBeforeItIsWholeIsDroppedAndDeleted() throws {
    let loader = try server.serve("b", Fixtures.pair("flac", "flac").b)
    loader.chunk = 1024
    loader.delay = 0.01
    let store = makeStore()
    let source = try store.source(for: item("b", key: "b:original"))
    var buffer = [UInt8](repeating: 0, count: 4096)
    _ = try buffer.withUnsafeMutableBytes { try source.read(at: 0, count: 4096, into: $0.baseAddress!) }
    // Skipped part way.
    store.discard(source)
    XCTAssertEqual(reports.wait(for: 1), [.dropped(cacheKey: "b:original", message: "Stopped before it was whole")])
    XCTAssertEqual(files(), [])
    XCTAssertEqual(store.downloading, [])
  }

  func testCancellingAPrefetchLeavesTheDownloadToTheItemPlayingIt() throws {
    let fixture = Fixtures.pair("alac", "m4a").a
    let loader = try server.serve("a", fixture)
    loader.delay = 0.002
    let store = makeStore()
    store.prefetch(cacheKey: "a:original", url: url("a"))
    let source = try store.source(for: item("a", key: "a:original"))
    // The queue moved on to it: the cache no longer fetches it, the engine plays it.
    store.cancelPrefetch(cacheKey: "a:original")
    XCTAssertEqual(try decodeAll(try FileDecoder(source: source)), decodeFile(fixture))
    guard case .complete(_, let file, _) = reports.wait(for: 1).first else { return XCTFail("no file: \(reports.all)") }
    store.discard(source)
    XCTAssertEqual(try Data(contentsOf: file), loader.data)
    XCTAssertEqual(loader.requests.filter { $0.to == nil }.count, 1, "downloaded twice: \(loader.requests)")
  }

  func testOneReaderLettingGoLeavesTheOtherReading() throws {
    // The same track twice in a row (repeat one): the playing item and the preload.
    let fixture = Fixtures.pair("flac", "flac").a
    let loader = try server.serve("a", fixture)
    loader.chunk = 4096
    loader.delay = 0.001
    let store = makeStore()
    let first = try store.source(for: item("a", key: "a:original"))
    let second = try store.source(for: item("a", key: "a:original"))
    first.cancel()
    store.discard(first)
    XCTAssertEqual(try decodeAll(try FileDecoder(source: second)), decodeFile(fixture))
    store.discard(second)
    guard case .complete = reports.wait(for: 1).first else { return XCTFail("no file: \(reports.all)") }
    XCTAssertEqual(loader.requests.count, 1)
  }

  func testAStreamWithoutAKeyIsDeletedOnceDone() throws {
    let fixture = Fixtures.pair("flac", "flac").a
    _ = try server.serve("a", fixture)
    let store = makeStore()
    let source = try store.source(for: item("a"))
    XCTAssertEqual(try decodeAll(try FileDecoder(source: source)), decodeFile(fixture))
    store.discard(source)
    XCTAssertEqual(files(), [])
    XCTAssertEqual(reports.all, [])
  }

  func testAStreamTheServerRefusesIsDropped() throws {
    let store = makeStore()
    store.prefetch(cacheKey: "gone:original", url: url("gone"))
    XCTAssertEqual(reports.wait(for: 1), [.dropped(cacheKey: "gone:original", message: "The server answered HTTP 404")])
    XCTAssertEqual(store.downloading, [])
  }

  func testPlayingTwoTracksFetchesEachOnceAndKeepsBoth() throws {
    let pair = Fixtures.pair("flac", "flac")
    let a = try server.serve("a", pair.a)
    let b = try server.serve("b", pair.b)
    // Slower than the decoders, as a network is: the prefetch is still running when the preload opens.
    b.delay = 0.01
    let store = makeStore()
    let harness = Harness(sources: store)
    // The cache fetches the next track ahead; the session preloads it under the same key.
    store.prefetch(cacheKey: "b:original", url: url("b", 1))
    harness.engine.load(harness.item("a", url("a"), cacheKey: "a:original"), autoplay: false)
    harness.engine.preload(harness.item("b", url("b", 2), cacheKey: "b:original"))
    harness.settle()
    harness.engine.play()
    harness.settle()
    harness.run(seconds: 3.4)

    XCTAssertEqual(harness.ended, ["a", "b"])
    XCTAssertEqual(Array(harness.output.heard.prefix(Fixtures.reference.count)), Fixtures.reference, "the output is not the uncut original")
    XCTAssertEqual(a.requests.count, 1, "a: \(a.requests)")
    XCTAssertEqual(b.requests.count, 1, "b: \(b.requests)")
    let kept = reports.wait(for: 2).compactMap { report -> String? in
      guard case .complete(let key, let file, _) = report, FileManager.default.fileExists(atPath: file.path) else { return nil }
      return key
    }
    XCTAssertEqual(kept.sorted(), ["a:original", "b:original"])
  }
}
