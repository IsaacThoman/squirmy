import AVFoundation
import XCTest
@testable import SquirmyAudioCore

/// Crossfades between entries on a fake output: their shape and timing, the album rule, and
/// what skips, seeks, preloads and the sleep timer's fade do to one.
final class CrossfadeTests: XCTestCase {
  private let rate = 48_000.0
  /// Quiet tones, as every test sound is.
  private let amplitude: Float = 0.1
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("squirmy-crossfade-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func testTwoTonesCrossfadedOverFourSecondsKeepTheirPower() throws {
    let a = try toneFile(1_000, seconds: 8)
    let b = try toneFile(1_500, seconds: 8)
    let harness = start(a, then: b, crossfade: 4)
    // Through the fade at 4 s and to the end of the second tone at 12 s.
    harness.run(seconds: 12.2)
    let heard = harness.output.heard
    let first = try XCTUnwrap(firstSound(heard))
    let fadeStart = first + Int(rate * 4)
    let steady = Double(amplitude) / 2.squareRoot()
    // From a second before the fade to a second after it, 50 ms at a time.
    for window in stride(from: fadeStart - Int(rate), to: fadeStart + Int(rate * 5), by: 2400) {
      let level = Double(rms(Array(heard[window * 2..<(window + 2400) * 2])))
      XCTAssertEqual(20 * log10(level / steady), 0, accuracy: 0.5, "at \(Double(window - fadeStart) / rate) s into the fade")
    }
    // Equal power along the way: each tone at the cosine and sine of the fade's progress.
    for seconds in [0.5, 2.0, 3.5] {
      let window = Array(heard[(fadeStart + Int(rate * seconds) - 1200) * 2..<(fadeStart + Int(rate * seconds) + 1200) * 2])
      let angle = seconds / 4 * Double.pi / 2
      XCTAssertEqual(toneLevel(window, 1_000), Double(amplitude) * cos(angle), accuracy: 0.004, "outgoing at \(seconds) s")
      XCTAssertEqual(toneLevel(window, 1_500), Double(amplitude) * sin(angle), accuracy: 0.004, "incoming at \(seconds) s")
    }
    XCTAssertEqual(harness.ended, ["a", "b"])
  }

  func testEndedArrivesWhenTheIncomingEntryStarts() throws {
    let a = try toneFile(1_000, seconds: 6)
    let b = try toneFile(1_500, seconds: 6)
    var heardAtEnded: Int?
    let harness = start(a, then: b, crossfade: 3)
    harness.onEvent = { event in
      if case .ended("a") = event { heardAtEnded = harness.output.heard.count / 2 }
    }
    harness.run(seconds: 4)
    let first = try XCTUnwrap(firstSound(harness.output.heard))
    let endedAt = try XCTUnwrap(heardAtEnded)
    // Three seconds before the outgoing entry's end, within one 20 ms step.
    let incomingStart = first + Int(rate * 3)
    XCTAssertGreaterThanOrEqual(endedAt, incomingStart)
    XCTAssertLessThan(endedAt - incomingStart, Int(rate * 0.021))
    // From then on the status is the incoming entry's, from its start.
    let afterEnded = harness.events.drop { if case .ended = $0 { return false } else { return true } }.dropFirst().first
    guard case .status(let status)? = afterEnded else { return XCTFail("no status after ended") }
    XCTAssertEqual(status.entryId, "b")
    XCTAssertEqual(status.state, .playing)
    XCTAssertLessThan(status.positionMs, 25)
    // A second in, less the silence the played load began with.
    XCTAssertEqual(harness.status.positionMs, 1_000 - Double(first) / rate * 1000, accuracy: 25)
  }

  func testAlbumTracksStayGaplessWithCrossfadeOn() {
    let pair = Fixtures.pair("flac", "flac")
    for albumRun in [true, false] {
      let harness = Harness()
      harness.engine.setCrossfade(seconds: 4)
      harness.engine.load(harness.item("a", pair.a), autoplay: false)
      var next = harness.item("b", pair.b)
      next.albumRun = albumRun
      harness.engine.preload(next)
      harness.settle()
      harness.engine.play()
      harness.settle()
      harness.run(seconds: 3.4)
      XCTAssertEqual(harness.ended, ["a", "b"])
      let heard = Array(harness.output.heard.prefix(Fixtures.reference.count))
      if albumRun {
        XCTAssertEqual(heard, Fixtures.reference, "the album's tracks did not meet gapless")
      } else {
        // The other way, they overlap: a crossfade as long as half the shorter one.
        XCTAssertLessThan(harness.output.heard.count, Fixtures.reference.count - Int(Fixtures.rate) / 2 * 2)
      }
    }
  }

  func testTheSleepFadeTurnsDownBothEntriesOfACrossfade() throws {
    let a = try toneFile(1_000, seconds: 8)
    let b = try toneFile(1_500, seconds: 8)
    let harness = start(a, then: b, crossfade: 4)
    // Into the fade, which began at 4 s.
    harness.run(seconds: 4.5)
    harness.engine.setFade(0.25)
    harness.run(seconds: 1.2)
    let heard = harness.output.heard
    let first = try XCTUnwrap(firstSound(heard))
    // Once the lead and the ramp are behind it: both tones at a quarter of their levels there.
    let at = first + Int(rate * 5.4)
    let window = Array(heard[(at - 1200) * 2..<(at + 1200) * 2])
    let angle = 1.4 / 4 * Double.pi / 2
    XCTAssertEqual(toneLevel(window, 1_000), Double(amplitude) * 0.25 * cos(angle), accuracy: 0.002)
    XCTAssertEqual(toneLevel(window, 1_500), Double(amplitude) * 0.25 * sin(angle), accuracy: 0.002)
  }

  func testASkipInAFadeLeavesOnlyTheNewEntry() throws {
    let a = try toneFile(1_000, seconds: 8)
    let b = try toneFile(1_500, seconds: 8)
    let c = try toneFile(700, seconds: 3)
    let harness = start(a, then: b, crossfade: 4)
    harness.run(seconds: 5)
    XCTAssertEqual(harness.status.entryId, "b")
    let discarded = harness.factory.discarded
    harness.engine.load(harness.item("c", c), autoplay: true)
    harness.settle()
    harness.output.resetHearing()
    harness.run(seconds: 1)
    let heard = harness.output.heard
    // Only the new entry, the outgoing one let go with the one it was fading into.
    XCTAssertGreaterThan(toneLevel(Array(heard.suffix(4800)), 700), Double(amplitude) * 0.95)
    XCTAssertLessThan(toneLevel(Array(heard.suffix(4800)), 1_000), 1e-4)
    XCTAssertLessThan(toneLevel(Array(heard.suffix(4800)), 1_500), 1e-4)
    // Let go of on their own queues.
    let deadline = Date().addingTimeInterval(2)
    while harness.factory.discarded - discarded < 2, Date() < deadline { usleep(1_000) }
    XCTAssertEqual(harness.factory.discarded - discarded, 2)
    XCTAssertEqual(harness.ended, ["a"])
  }

  func testSeekingInTheIncomingEntryEndsTheFade() throws {
    let a = try toneFile(1_000, seconds: 8)
    let b = try toneFile(1_500, seconds: 8)
    let harness = start(a, then: b, crossfade: 4)
    harness.run(seconds: 5)
    harness.engine.seek(toMs: 3_000)
    harness.settle()
    harness.output.resetHearing()
    harness.run(seconds: 0.6)
    let heard = Array(harness.output.heard.suffix(4800))
    XCTAssertGreaterThan(toneLevel(heard, 1_500), Double(amplitude) * 0.95)
    XCTAssertLessThan(toneLevel(heard, 1_000), 1e-4)
    XCTAssertEqual(harness.status.positionMs, 3_600, accuracy: 30)
  }

  func testSeekingBackBeforeTheFadeCrossfadesAgainWhenItComes() throws {
    let a = try toneFile(1_000, seconds: 6)
    let b = try toneFile(1_500, seconds: 6)
    let harness = start(a, then: b, crossfade: 2)
    // Just before the fade, with its start queued.
    harness.run(seconds: 3.8)
    XCTAssertEqual(harness.status.entryId, "a")
    harness.engine.seek(toMs: 1_000)
    harness.settle()
    harness.output.resetHearing()
    harness.run(seconds: 4.3)
    XCTAssertEqual(harness.ended, ["a"])
    let heard = harness.output.heard
    let first = try XCTUnwrap(firstSound(heard))
    // Three seconds of the outgoing entry alone, then the fade: half way through it, both at 0.707.
    XCTAssertLessThan(toneLevel(Array(heard[(first + Int(rate * 2.5)) * 2..<(first + Int(rate * 2.55)) * 2]), 1_500), 1e-4)
    let middle = Array(heard[(first + Int(rate * 4) - 1200) * 2..<(first + Int(rate * 4) + 1200) * 2])
    XCTAssertEqual(toneLevel(middle, 1_000), Double(amplitude) * 0.707, accuracy: 0.004)
    XCTAssertEqual(toneLevel(middle, 1_500), Double(amplitude) * 0.707, accuracy: 0.004)
  }

  func testAPreloadThatArrivesLateGetsWhatIsLeftOfTheFade() throws {
    let a = try toneFile(1_000, seconds: 5)
    let b = try toneFile(1_500, seconds: 5)
    let harness = Harness(rate: rate)
    harness.engine.setCrossfade(seconds: 4)
    harness.engine.load(harness.item("a", a), autoplay: true)
    harness.settle()
    harness.run(seconds: 3.5)
    harness.engine.preload(harness.item("b", b))
    harness.run(seconds: 0.5)
    // It starts at once (after what was queued), with a second and a bit of the outgoing entry left to fade over.
    XCTAssertEqual(harness.ended, ["a"])
    XCTAssertEqual(harness.status.entryId, "b")
    harness.run(seconds: 1.5)
    let heard = harness.output.heard
    let tail = Array(heard.suffix(4800))
    XCTAssertLessThan(toneLevel(tail, 1_000), 1e-4)
    XCTAssertGreaterThan(toneLevel(tail, 1_500), Double(amplitude) * 0.95)
  }

  func testAReplacedPreloadIsCrossfadedIntoInstead() throws {
    let a = try toneFile(1_000, seconds: 5)
    let b = try toneFile(1_500, seconds: 5)
    let c = try toneFile(700, seconds: 5)
    let harness = start(a, then: b, crossfade: 2)
    // The fade into b begins at 3 s and is queued 0.4 s ahead.
    harness.run(seconds: 2.8)
    harness.engine.preload(harness.item("c", c))
    harness.run(seconds: 2.7)
    XCTAssertEqual(harness.ended, ["a"])
    XCTAssertEqual(harness.status.entryId, "c")
    let heard = harness.output.heard
    let first = try XCTUnwrap(firstSound(heard))
    // What was queued of b is never heard. c fades in from about where b would have (later by
    // what was queued before c had frames to mix), and plays on alone once a is over.
    XCTAssertLessThan(toneLevel(Array(heard), 1_500), 1e-4)
    let inFade = Array(heard[(first + Int(rate * 4.2) - 1200) * 2..<(first + Int(rate * 4.2) + 1200) * 2])
    XCTAssertGreaterThan(toneLevel(inFade, 700), Double(amplitude) * 0.5)
    XCTAssertGreaterThan(toneLevel(inFade, 1_000), Double(amplitude) * 0.3)
    let after = Array(heard[(first + Int(rate * 5.1)) * 2..<(first + Int(rate * 5.2)) * 2])
    XCTAssertEqual(toneLevel(after, 700), Double(amplitude), accuracy: 0.002)
    XCTAssertLessThan(toneLevel(after, 1_000), 1e-4)
  }

  func testRenderingAgainInAFadeChangesNothingHeard() throws {
    let a = try toneFile(1_000, seconds: 8)
    let b = try toneFile(1_500, seconds: 8)
    let steady = start(a, then: b, crossfade: 4)
    steady.run(seconds: 8)
    let flushed = start(a, then: b, crossfade: 4)
    // Once before the outgoing entry is heard to fade, once after.
    for seconds in [3.9, 1.0] {
      flushed.run(seconds: seconds)
      flushed.engine.queue.sync {
        let frame = Int64(flushed.output.currentFrame())
        flushed.output.flush()
        flushed.output.onEvent?(.flushedAutomatically(at: frame))
      }
    }
    flushed.run(seconds: 8 - 4.9)
    let count = min(steady.output.heard.count, flushed.output.heard.count)
    XCTAssertGreaterThan(count, Int(rate * 7.9) * 2)
    XCTAssertLessThan(maxDifference(steady.output.heard.prefix(count), flushed.output.heard.prefix(count)), 1e-6)
  }

  func testTurningCrossfadeOffKeepsTracksGapless() throws {
    let a = try toneFile(1_000, seconds: 2)
    let b = try toneFile(1_500, seconds: 2)
    let harness = start(a, then: b, crossfade: 0)
    harness.run(seconds: 4.2)
    XCTAssertEqual(harness.ended, ["a", "b"])
    XCTAssertEqual(harness.output.heard.count / 2 - firstSound(harness.output.heard)!, Int(rate * 4), "the two entries overlap")
  }

  // MARK: - Helpers

  /// `a` playing from its start with `b` preloaded and the crossfade set.
  private func start(_ a: URL, then b: URL, crossfade: Double) -> Harness {
    let harness = Harness(rate: rate)
    harness.engine.setCrossfade(seconds: crossfade)
    harness.engine.load(harness.item("a", a), autoplay: true)
    harness.engine.preload(harness.item("b", b))
    harness.settle()
    return harness
  }

  /// A stereo float tone in a CAF file at the test's rate.
  private func toneFile(_ frequency: Double, seconds: Double) throws -> URL {
    let url = directory.appendingPathComponent("\(Int(frequency))-\(seconds).caf")
    if FileManager.default.fileExists(atPath: url.path) { return url }
    let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2)!
    let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    let frames = AVAudioFrameCount(rate * seconds)
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
    buffer.frameLength = frames
    for frame in 0..<Int(frames) {
      // Off zero at its first frame, so where it starts can be told.
      let value = amplitude * Float(sin(2 * Double.pi * frequency * Double(frame) / rate + 0.5))
      buffer.floatChannelData![0][frame] = value
      buffer.floatChannelData![1][frame] = value
    }
    try file.write(from: buffer)
    return url
  }

  /// The first frame heard that is not silence.
  private func firstSound(_ heard: [Float]) -> Int? {
    stride(from: 0, to: heard.count, by: 2).first { heard[$0] != 0 }.map { $0 / 2 }
  }

  /// The amplitude of the `frequency` sine in the left channel of `samples`.
  private func toneLevel(_ samples: [Float], _ frequency: Double) -> Double {
    let left = channel(samples, 0)
    var re = 0.0
    var im = 0.0
    for (index, value) in left.enumerated() {
      let phase = 2 * Double.pi * frequency * Double(index) / rate
      re += Double(value) * cos(phase)
      im += Double(value) * sin(phase)
    }
    return 2 * (re * re + im * im).squareRoot() / Double(left.count)
  }
}
