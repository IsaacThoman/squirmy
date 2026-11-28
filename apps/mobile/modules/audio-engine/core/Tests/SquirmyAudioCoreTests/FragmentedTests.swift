import XCTest
@testable import SquirmyAudioCore

/// The server's fragmented MP4 transcodes (`scripts/make-fragmented-fixtures.mjs`): exact
/// boundaries with the descriptor's numbers, seeks inside a stream, and a seek past what has
/// arrived of a transcode still being sent.
final class FragmentedTests: XCTestCase {
  private let profiles = ["flac_mp4", "opus_mp4_192", "opus_mp4_96", "aac_mp4_256", "aac_mp4_128"]
  private var directory: URL!

  override func setUp() {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("squirmy-fragmented-tests-\(UUID().uuidString)")
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: directory)
  }

  private func decoder(_ name: String, canRestart: Bool = false) throws -> StreamDecoder {
    try StreamDecoder(source: try FileByteSource(url: Fixtures.url(name)), gapless: Fixtures.fragmented[name]!.numbers, canRestart: canRestart)
  }

  /// The reference at a fixture's delivered rate, and where the split is there.
  private func reference(at rate: Double) -> (samples: [Float], split: Int) {
    let samples = rate == Fixtures.rate ? Fixtures.reference : resampled(Fixtures.reference, to: rate)
    return (samples, Int((Double(Fixtures.splitFrame) * rate / Fixtures.rate).rounded()))
  }

  func testEveryFragmentedProfileDecodesToTheTracksExactLengthAndJoinsWithoutAGap() throws {
    for profile in profiles {
      let a = try decodeAll(try decoder("\(profile).a.mp4"))
      let b = try decodeAll(try decoder("\(profile).b.mp4"))
      let numbers = Fixtures.fragmented["\(profile).a.mp4"]!.gapless
      XCTAssertEqual(Int64(a.count / 2), numbers.frames, profile)
      XCTAssertEqual(Int64(b.count / 2), Fixtures.fragmented["\(profile).b.mp4"]!.gapless.frames, profile)
      let (samples, split) = reference(at: numbers.sampleRate)
      // Resampled halves (Opus is 48 kHz) are each rounded to a whole frame.
      let tolerance = numbers.sampleRate == Fixtures.rate ? 0 : 1
      XCTAssertLessThanOrEqual(abs(boundaryGap(a: a, b: b, reference: samples, split: split)), tolerance, profile)
      // Each half where it belongs, not only the two against each other: a decoder that starts
      // late by the same amount in both would still meet at the boundary.
      let left = channel(samples, 0)
      XCTAssertEqual(bestLag(channel(a, 0), left, refStart: 8192, start: 8192, maxLag: 400), 0, profile)
      XCTAssertLessThanOrEqual(abs(bestLag(channel(b, 0), left, refStart: split + 8192, start: 8192, maxLag: 400)), tolerance, profile)
    }
  }

  func testLosslessHalvesThroughTheEngineAreTheUncutOriginal() {
    let harness = Harness()
    for (id, half) in [("a", "flac_mp4.a.mp4"), ("b", "flac_mp4.b.mp4")] {
      let item = harness.item(id, Fixtures.url(half), decoder: .stream, gapless: Fixtures.fragmented[half]!.numbers)
      if id == "a" { harness.engine.load(item, autoplay: false) } else { harness.engine.preload(item) }
    }
    harness.settle()
    harness.engine.play()
    harness.settle()
    harness.run(seconds: 3.4)
    XCTAssertEqual(harness.output.heardFrom, 0)
    XCTAssertEqual(Array(harness.output.heard.prefix(Fixtures.reference.count)), Fixtures.reference)
    XCTAssertEqual(harness.ended, ["a", "b"])
  }

  func testOpusHalvesThroughTheEngineMeetOnTheSample() {
    let harness = Harness(rate: 48_000)
    let names = ["opus_mp4_96.a.mp4", "opus_mp4_96.b.mp4"]
    harness.engine.load(harness.item("a", Fixtures.url(names[0]), decoder: .stream, gapless: Fixtures.fragmented[names[0]]!.numbers), autoplay: false)
    harness.engine.preload(harness.item("b", Fixtures.url(names[1]), decoder: .stream, gapless: Fixtures.fragmented[names[1]]!.numbers))
    harness.settle()
    harness.engine.play()
    harness.settle()
    harness.run(seconds: 3.4)
    let a = decodeFile(Fixtures.url(names[0]), kind: .stream, gapless: Fixtures.fragmented[names[0]]!.numbers)
    let b = decodeFile(Fixtures.url(names[1]), kind: .stream, gapless: Fixtures.fragmented[names[1]]!.numbers)
    let heard = harness.output.heard.prefix(a.count + b.count)
    XCTAssertEqual(heard.count, a.count + b.count)
    XCTAssertLessThan(maxDifference(heard, (a + b)[0...]), 1e-6, "the output is not the two decoded halves back to back")
    XCTAssertEqual(harness.ended, ["a", "b"])
  }

  func testASeekInsideTheStreamLandsOnTheSample() throws {
    for (name, frame) in [("flac_mp4.b.mp4", 40_000), ("aac_mp4_256.whole.mp4", 70_001), ("opus_mp4_96.whole.mp4", 100_003)] {
      let whole = try decodeAll(try decoder(name))
      let seeking = try decoder(name)
      _ = try seeking.read(maxFrames: 4096)
      try seeking.seek(to: Int64(frame))
      let after = try decodeAll(seeking)
      XCTAssertEqual(after.count, whole.count - frame * 2, name)
      let expected = whole[(frame * 2)...]
      if name.hasPrefix("flac") {
        XCTAssertEqual(Array(after), Array(expected), name)
      } else {
        // A lossy decoder started a little before the target settles to what it would
        // have decoded straight through.
        XCTAssertEqual(bestLag(channel(after, 0), channel(Array(expected), 0), refStart: 2048, start: 2048, maxLag: 64), 0, name)
        XCTAssertLessThan(maxDifference(after[2048 * 2..<8192 * 2], expected.dropFirst(2048 * 2).prefix(6144 * 2)), 1e-3, name)
      }
      // And back to the start.
      try seeking.seek(to: 0)
      XCTAssertEqual(try decodeAll(seeking).count, whole.count, name)
    }
  }

  func testASeekPastWhatHasArrivedOfATranscodeIsSentFromThere() throws {
    let name = "opus_mp4_96.whole.mp4"
    let source = try GatedSource(url: Fixtures.url(name), allowed: 20_000)
    let decoder = try StreamDecoder(source: source, gapless: Fixtures.fragmented[name]!.numbers, canRestart: true)
    // Inside what has arrived.
    try decoder.seek(to: 5_000)
    XCTAssertFalse(try decoder.read(maxFrames: 1024).isEmpty)
    XCTAssertThrowsError(try decoder.seek(to: 100_000)) { XCTAssertTrue($0 is SeekOutsideStream) }
  }

  func testAStreamSentFromATimeIsNumberedFromWhereItBegins() throws {
    for name in ["opus_mp4_96.from-2000.mp4", "aac_mp4_256.from-1500.mp4"] {
      let fixture = Fixtures.fragmented[name]!
      let loader = FakeLoader(data: try Data(contentsOf: Fixtures.url(name)))
      loader.startFrame = fixture.startFrame
      loader.ranges = false
      loader.sendsLength = false
      let source = try ByteCache(url: URL(string: "https://music.example/stream/\(name)?start=\(fixture.startMs!)")!, loader: loader,
                                 file: directory.appendingPathComponent(name))
      let decoder = try StreamDecoder(source: source, gapless: fixture.numbers, canRestart: true)
      XCTAssertEqual(decoder.startFrame, fixture.startFrame)
      let decoded = try decodeAll(decoder)
      // To the end of the track, and no further.
      XCTAssertEqual(Int64(decoded.count / 2), fixture.gapless.frames - fixture.startFrame!, name)
      let (samples, _) = reference(at: fixture.gapless.sampleRate)
      let start = Int(fixture.startFrame!)
      XCTAssertEqual(bestLag(channel(decoded, 0), channel(samples, 0), refStart: start + 1024, start: 1024, maxLag: 64), 0, name)
      XCTAssertThrowsError(try decoder.seek(to: fixture.startFrame! - 1)) { XCTAssertTrue($0 is SeekOutsideStream) }
    }
  }

  func testTheOpusProbeFindsOpusHere() {
    // macOS 27 and the iOS 27 simulator decode both samples; an older system that cannot gets AAC.
    XCTAssertTrue(OpusProbe.decodesOpus())
    XCTAssertEqual(OpusProbe.codecs, ["flac", "alac", "aac", "mp3", "wav", "aiff", "opus"])
  }

  func testSeekingPastWhatHasArrivedOfALiveTranscodePlaysTheRightSample() throws {
    let server = FakeServer()
    let whole = "opus_mp4_96.whole.mp4"
    let from = "opus_mp4_96.from-2000.mp4"
    // A transcode still being encoded: no length, no Range, arriving slowly.
    let live = try server.serve("song", Fixtures.url(whole))
    live.ranges = false
    live.sendsLength = false
    live.chunk = 4096
    live.delay = 0.1
    _ = try server.serveSeek("song", Fixtures.url(from), startFrame: Fixtures.fragmented[from]!.startFrame!)
    let reports = ReportLog()
    let store = StreamStore(loader: server, directory: directory, report: { reports.add($0) })
    let harness = Harness(rate: 48_000, sources: store)
    let url = URL(string: "https://music.example/api/v1/stream/song?sig=1")!
    harness.engine.load(harness.item("song", url, decoder: .stream, gapless: Fixtures.fragmented[whole]!.numbers, cacheKey: "song:opus_mp4_96"), autoplay: true)
    // Waiting for the first second only: the rest is still on its way.
    while harness.status.state == .loading { harness.run(seconds: 0.02, decoders: false) }
    harness.run(seconds: 0.2, decoders: false)
    harness.engine.seek(toMs: 2000)
    harness.settle()
    harness.output.resetHearing()
    harness.run(seconds: 0.6)

    XCTAssertEqual(server.starts, ["2000.000"])
    XCTAssertEqual(harness.status.state, .playing)
    // Silence while the stream from there arrived, then the track from 2.000 s on, to the sample.
    let reference = channel(resampled(Fixtures.reference, to: 48_000), 0)
    let heard = channel(harness.output.heard, 0)
    let onset = try XCTUnwrap(heard.firstIndex { $0 != 0 })
    XCTAssertGreaterThan(heard.count - onset, 20_000)
    XCTAssertEqual(bestLag(heard, reference, refStart: 96_000 + 8192, start: onset + 8192, maxLag: 64), 0)
    XCTAssertEqual(harness.status.positionMs, 2000 + Double(heard.count - onset) / 48, accuracy: 1)
    // The stream it left is not kept.
    XCTAssertEqual(reports.wait(for: 1), [.dropped(cacheKey: "song:opus_mp4_96", message: "Stopped before it was whole")])
  }
}
