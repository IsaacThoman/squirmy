import XCTest
@testable import SquirmyAudioCore

/// The stream's bytes in one sparse file: what the decoders read while it downloads.
final class ByteCacheTests: XCTestCase {
  private var directory: URL!

  override func setUp() {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("squirmy-cache-tests-\(UUID().uuidString)")
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
  }

  /// A cache that asks for what it is missing sooner than the app's, since these files are small.
  private func cache(_ loader: FakeLoader, _ name: String) throws -> ByteCache {
    try ByteCache(url: URL(string: "https://music.example/stream/\(name)")!, loader: loader, file: directory.appendingPathComponent(name), nearWindow: 16 * 1024)
  }

  func testAnMP4WithItsIndexAtTheEndPlaysBeforeItHasDownloaded() throws {
    // ffmpeg writes the index (`moov`) after the audio, as many ALAC files have it.
    let url = Fixtures.pair("alac", "m4a").b
    let loader = FakeLoader(data: try Data(contentsOf: url))
    loader.chunk = 8 * 1024
    loader.delay = 0.02
    let bytes = try cache(loader, "b.m4a")
    let decoder = try FileDecoder(source: bytes)
    let first = try decoder.read(maxFrames: 4096)
    XCTAssertEqual(first.count, 8192)
    XCTAssertFalse(bytes.isComplete, "waited for the whole download")
    XCTAssertTrue(loader.requests.contains { $0.from > 0 }, "the end was not fetched with a Range request")
    let rest = try decodeAll(decoder)
    XCTAssertEqual(first + rest, decodeFile(url))
  }

  func testATranscodeWithoutALengthOrRangesStreamsToItsEnd() throws {
    let url = Fixtures.pair("aac_256", "aac").a
    let loader = FakeLoader(data: try Data(contentsOf: url))
    loader.ranges = false
    loader.sendsLength = false
    loader.chunk = 4 * 1024
    let bytes = try cache(loader, "a.aac")
    let decoded = try decodeAll(try StreamDecoder(source: bytes, gapless: nil))
    let direct = decodeFile(url, kind: .stream)
    XCTAssertEqual(decoded.count, direct.count)
    // Apple's AAC decoder rounds differently with how the packets arrive, by a few 1e-9.
    XCTAssertLessThan(maxDifference(decoded[0...], direct[0...]), 1e-7)
    XCTAssertEqual(loader.requests.count, 1)
    XCTAssertTrue(bytes.isComplete)
  }

  func testADownloadThatBreaksResumesWhereItStopped() throws {
    let url = Fixtures.pair("flac", "flac").b
    let data = try Data(contentsOf: url)
    let loader = FakeLoader(data: data)
    loader.failAt = Int64(data.count / 2)
    let bytes = try cache(loader, "b.flac")
    let decoded = try decodeAll(try FileDecoder(source: bytes))
    XCTAssertEqual(decoded, decodeFile(url))
    XCTAssertTrue(loader.requests.contains { $0.from >= Int64(data.count / 2) && $0.to == nil }, "did not resume from where it broke")
    XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("b.flac")), data)
  }

  func testARefusalFailsTheReadWithTheServersStatus() throws {
    let loader = FakeLoader(data: Data(count: 1000))
    loader.status = 404
    let bytes = try cache(loader, "gone")
    XCTAssertThrowsError(try bytes.info()) { error in
      XCTAssertEqual((error as? EngineError)?.message, "The server answered HTTP 404")
    }
  }

  func testCancellingWakesAWaitingRead() throws {
    let loader = FakeLoader(data: Data(count: 1_000_000))
    loader.chunk = 1024
    loader.delay = 0.05
    loader.ranges = false
    let bytes = try cache(loader, "slow")
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) { bytes.cancel() }
    var buffer = [UInt8](repeating: 0, count: 16)
    XCTAssertThrowsError(try buffer.withUnsafeMutableBytes { try bytes.read(at: 900_000, count: 16, into: $0.baseAddress!) })
  }

  func testRangesMerge() {
    var set = RangeSet()
    set.insert(0..<10)
    set.insert(20..<30)
    XCTAssertFalse(set.contains(5..<25))
    set.insert(10..<20)
    XCTAssertTrue(set.contains(5..<25))
    XCTAssertEqual(set.ranges, [0..<30])
    XCTAssertEqual(set.end(of: 12), 30)
    XCTAssertNil(set.end(of: 30))
  }
}
