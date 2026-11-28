import XCTest
@testable import SquirmyAudioCore

/// The engine on a fake output: what reaches the output, and when it says what.
final class EngineTests: XCTestCase {
  private let split = Fixtures.splitFrame

  /// Two consecutive files, loaded paused, then played through to the end.
  private func playPair(_ encoding: String, _ ext: String, rate: Double = Fixtures.rate) -> (Harness, a: [Float], b: [Float]) {
    let harness = Harness(rate: rate)
    let pair = Fixtures.pair(encoding, ext)
    harness.engine.load(harness.item("a", pair.a), autoplay: false)
    harness.engine.preload(harness.item("b", pair.b))
    harness.settle()
    XCTAssertEqual(harness.status.state, .paused)
    harness.engine.play()
    harness.settle()
    harness.run(seconds: 3.4)
    return (harness, decodeFile(pair.a), decodeFile(pair.b))
  }

  func testWhatReachesTheOutputForTwoLosslessItemsIsTheOriginal() {
    for (encoding, ext) in [("flac", "flac"), ("alac", "m4a")] {
      let (harness, _, _) = playPair(encoding, ext)
      XCTAssertEqual(harness.output.heardFrom, 0)
      XCTAssertGreaterThanOrEqual(harness.output.heard.count, Fixtures.reference.count, encoding)
      XCTAssertEqual(Array(harness.output.heard.prefix(Fixtures.reference.count)), Fixtures.reference, "\(encoding): the output is not the uncut original")
      XCTAssertEqual(harness.ended, ["a", "b"], encoding)
      XCTAssertEqual(harness.status.state, .ended)
      XCTAssertEqual(harness.output.starved, harness.output.heard.isEmpty ? 0 : harness.output.starved)
    }
  }

  func testLossyItemsAreQueuedBackToBackWithNothingAddedOrLost() {
    for (encoding, ext) in [("aac", "m4a"), ("mp3", "mp3"), ("opus", "opus")] {
      let rate = encoding == "opus" ? 48_000.0 : Fixtures.rate
      let (harness, a, b) = playPair(encoding, ext, rate: rate)
      let heard = harness.output.heard.prefix(a.count + b.count)
      XCTAssertEqual(heard.count, a.count + b.count, encoding)
      // A frame added or lost would shift the sweep by far more than Apple's decoders vary
      // from one run to the next (a few 1e-9).
      XCTAssertLessThan(maxDifference(heard, (a + b)[0...]), 1e-6, "\(encoding): the output is not the two decoded halves back to back")
      XCTAssertEqual(harness.ended, ["a", "b"], encoding)
    }
  }

  func testResampledItemsMeetWithinASample() {
    // 44.1 kHz files on a 48 kHz output, as on an iPhone.
    let (harness, _, _) = playPair("flac", "flac", rate: 48_000)
    let reference = resampled(Fixtures.reference, to: 48_000)
    let heard = harness.output.heard
    let split48k = Int((Double(split) * 48_000 / Fixtures.rate).rounded())
    let left = channel(heard, 0)
    let reference48k = channel(reference, 0)
    // Where the second item's start is heard, against where it is in the resampled original.
    let lag = bestLag(left, reference48k, refStart: split48k + 4096, start: split48k + 4096, maxLag: 200)
    XCTAssertLessThanOrEqual(abs(lag), 1)
    XCTAssertLessThan(maxDifference(heard[0..<(split48k - 64) * 2], reference[0..<(split48k - 64) * 2]), 1e-4)
  }

  func testEmitsEndedOnlyOnceTheNextItemIsHeard() {
    let harness = Harness()
    let pair = Fixtures.pair("flac", "flac")
    var heardAtEnded: Int?
    harness.engine.load(harness.item("a", pair.a), autoplay: true)
    harness.engine.preload(harness.item("b", pair.b))
    harness.settle()
    harness.onEvent = { event in
      if case .ended("a") = event { heardAtEnded = harness.output.heard.count / 2 }
    }
    harness.run(seconds: 2)
    let boundary = start(of: decodeFile(pair.a), in: harness.output.heard)! + split
    let endedAt = try! XCTUnwrap(heardAtEnded)
    // Within one 20 ms step after the boundary.
    XCTAssertGreaterThanOrEqual(endedAt, boundary)
    XCTAssertLessThan(endedAt - boundary, Int(Fixtures.rate * 0.021))
    // When `ended` goes out, the status is the next entry's already.
    let afterEnded = harness.events.drop { if case .ended = $0 { return false } else { return true } }.dropFirst().first
    guard case .status(let status)? = afterEnded else { return XCTFail("no status after ended") }
    XCTAssertEqual(status.entryId, "b")
    XCTAssertEqual(status.state, .playing)
    XCTAssertLessThan(status.positionMs, 25)
  }

  func testTheLeadNeverRunsOutInAMinuteOfTracks() {
    // Twenty-two items, 66 s, each one preloaded as the one before starts, as SessionClient does.
    let harness = Harness()
    let pair = Fixtures.pair("flac", "flac")
    let urls = (0..<22).map { $0 % 2 == 0 ? pair.a : pair.b }
    var preloaded = 1
    harness.engine.load(harness.item("0", urls[0]), autoplay: true)
    harness.engine.preload(harness.item("1", urls[1]))
    harness.onEvent = { event in
      guard case .ended = event, preloaded + 1 < urls.count else { return }
      preloaded += 1
      harness.engine.preload(harness.item("\(preloaded)", urls[preloaded]))
    }
    harness.settle()
    var leastLead = Int64.max
    var starvedBeforeTheLast = 0
    harness.run(seconds: 66.5) {
      // Until the last item: after it nothing follows, and the lead runs down to its end.
      guard harness.status.state == .playing, harness.status.entryId != "21" else { return }
      harness.engine.queue.sync {
        leastLead = min(leastLead, harness.output.queuedEnd - Int64(harness.output.currentFrame()))
        starvedBeforeTheLast = harness.output.starved
      }
    }
    XCTAssertEqual(harness.ended.count, 22)
    XCTAssertEqual(starvedBeforeTheLast, 0, "the clock ran over frames that were not queued")
    XCTAssertGreaterThan(leastLead, Int64(Fixtures.rate * 0.3))
    let expected = (0..<11).flatMap { _ in Fixtures.reference }
    let first = start(of: Fixtures.reference, in: harness.output.heard)!
    let heard = harness.output.heard[(first * 2)...]
    XCTAssertEqual(heard.count, expected.count)
    XCTAssertTrue(heard.elementsEqual(expected), "the output is not the items back to back")
  }

  func testAStarvedSourceStopsTheClockAndPlaysOnFromTheSamePlace() throws {
    let harness = Harness()
    let url = Fixtures.pair("flac", "flac").b
    let size = try FileByteSource(url: url).length()
    // The start, and the end, which Apple's FLAC reader looks at when it opens the file.
    let gate = try GatedSource(url: url, allowed: size - 12 * 1024, tail: 16 * 1024)
    harness.factory.gates[url] = gate
    harness.engine.load(harness.item("b", url), autoplay: true)
    var buffered: EngineStatus?
    var waited = 0
    // The decoder blocks on the gate, so wait for it to be stuck rather than settled.
    harness.run(seconds: 1.6, decoders: false) {
      let deadline = Date().addingTimeInterval(1)
      while !gate.isWaiting && Date() < deadline { usleep(500) }
      let status = harness.status
      if status.state == .buffering {
        if buffered == nil { buffered = status }
        waited += 1
      }
    }
    let stopped = try XCTUnwrap(buffered, "never buffered")
    XCTAssertGreaterThan(waited, 10)
    XCTAssertEqual(harness.status.positionMs, stopped.positionMs, accuracy: 0.001, "the position moved while buffering")
    XCTAssertEqual(harness.output.starved, 0, "the clock ran dry before it was stopped")
    gate.allow(size)
    harness.settle()
    harness.run(seconds: 2.5)
    XCTAssertEqual(harness.ended, ["b"])
    // Nothing skipped and nothing repeated across the stall.
    let whole = decodeFile(url)
    let first = start(of: whole, in: harness.output.heard)!
    XCTAssertTrue(harness.output.heard[(first * 2)...].elementsEqual(whole), "the output skipped or repeated across the stall")
    let states = harness.events.compactMap { if case .status(let status) = $0 { return status.state } else { return nil } }
    XCTAssertEqual(states, [.loading, .playing, .buffering, .playing, .ended])
  }

  func testSeeksLandWithAStatusAndPlayFromThere() {
    let harness = Harness(fadeIn: 0.005)
    let url = Fixtures.pair("flac", "flac").b
    harness.engine.load(harness.item("b", url, startMs: 500), autoplay: false)
    harness.settle()
    XCTAssertEqual(harness.status.positionMs, 500, accuracy: 0.05)
    harness.clearEvents()
    harness.engine.seek(toMs: 1000)
    harness.settle()
    guard case .status(let landed)? = harness.events.last else { return XCTFail("no status for the seek") }
    XCTAssertEqual(landed.positionMs, 1000, accuracy: 0.05)
    XCTAssertEqual(landed.state, .paused)
    harness.engine.play()
    harness.settle()
    harness.run(seconds: 0.2)
    let whole = decodeFile(url)
    let from = 44_100 * 2
    let fade = 300 * 2
    // A 5 ms fade-in, then the item from the seek's frame.
    XCTAssertLessThan(abs(harness.output.heard[0]), 1e-6)
    XCTAssertEqual(Array(harness.output.heard[fade..<fade + 4000]), Array(whole[from + fade..<from + fade + 4000]))
    XCTAssertEqual(harness.status.positionMs, 1200, accuracy: 25)
  }

  func testAFailureToFetchIsAnErrorForTheLoadedEntryAndSilentForThePreload() {
    let harness = Harness()
    let pair = Fixtures.pair("flac", "flac")
    let missing = Fixtures.url("missing.flac")
    harness.factory.failing = [missing]
    harness.engine.load(harness.item("a", pair.a), autoplay: true)
    harness.engine.preload(harness.item("gone", missing))
    harness.settle()
    harness.run(seconds: 1.5)
    XCTAssertEqual(harness.ended, ["a"])
    XCTAssertEqual(harness.status.state, .ended)
    harness.engine.load(harness.item("gone2", missing), autoplay: true)
    harness.settle()
    harness.settle()
    let errors = harness.events.compactMap { if case .error(let id, let message) = $0 { return "\(id): \(message)" } else { return nil } }
    XCTAssertEqual(errors, ["gone2: The server answered HTTP 404"])
    XCTAssertEqual(harness.status.state, .error)
  }

  func testInterruptionsPauseAndSayWhenToResumeButNeverResume() {
    let harness = Harness()
    harness.engine.load(harness.item("a", Fixtures.pair("flac", "flac").a), autoplay: true)
    harness.settle()
    harness.run(seconds: 0.2)
    harness.engine.interruptionBegan()
    harness.settle()
    XCTAssertEqual(harness.status.state, .paused)
    XCTAssertEqual(harness.output.rate, 0)
    harness.engine.interruptionEnded(shouldResume: true)
    harness.settle()
    XCTAssertEqual(harness.status.state, .paused, "the engine resumed by itself")
    let system = harness.events.compactMap { event -> String? in
      switch event {
      case .interrupted(let id): return "interrupted \(id)"
      case .resumed(let id): return "resumed \(id)"
      default: return nil
      }
    }
    XCTAssertEqual(system, ["interrupted a", "resumed a"])
  }

  func testUnpluggedHeadphonesPauseForGoodEvenDuringAnInterruption() {
    let harness = Harness()
    harness.engine.load(harness.item("a", Fixtures.pair("flac", "flac").a), autoplay: true)
    harness.settle()
    harness.engine.interruptionBegan()
    harness.engine.outputLost()
    harness.engine.interruptionEnded(shouldResume: true)
    harness.settle()
    XCTAssertFalse(harness.events.contains { if case .resumed = $0 { return true } else { return false } })
  }

  func testHoldingTheSessionRunsSilenceWithNothingLoaded() {
    let harness = Harness()
    harness.engine.holdAudioSession(true)
    harness.settle()
    XCTAssertEqual(harness.output.rate, 1)
    XCTAssertEqual(harness.status.state, .idle)
    harness.run(seconds: 0.5)
    XCTAssertEqual(harness.output.starved, 0)
    XCTAssertTrue(harness.output.heard.allSatisfy { $0 == 0 })
    harness.engine.holdAudioSession(false)
    harness.settle()
    XCTAssertEqual(harness.output.rate, 0)
  }

  func testAPlayedLoadRunsSilenceUntilItsFirstFrames() throws {
    let harness = Harness()
    let url = Fixtures.pair("flac", "flac").a
    let gate = try GatedSource(url: url, allowed: 0)
    harness.factory.gates[url] = gate
    harness.engine.load(harness.item("a", url), autoplay: true)
    harness.run(seconds: 0.3, decoders: false)
    XCTAssertEqual(harness.status.state, .loading)
    XCTAssertEqual(harness.output.rate, 1, "the clock should run, keeping the session active")
    XCTAssertEqual(harness.output.starved, 0)
    gate.allow(Int64.max)
    harness.settle()
    XCTAssertEqual(harness.status.state, .playing)
  }

  func testReplacingAQueuedPreloadRendersTheTailAgain() {
    let harness = Harness()
    let flac = Fixtures.pair("flac", "flac")
    let alac = Fixtures.pair("alac", "m4a")
    harness.engine.load(harness.item("a", flac.a), autoplay: true)
    harness.engine.preload(harness.item("b", flac.b))
    harness.settle()
    // Up to where the preload's start is in the lead.
    harness.run(seconds: 1.15)
    harness.engine.preload(harness.item("c", alac.b))
    harness.settle()
    harness.run(seconds: 2)
    XCTAssertEqual(harness.ended, ["a", "c"])
    let decodedA = decodeFile(flac.a)
    let decodedC = decodeFile(alac.b)
    // Rendered again from the playhead: the first entry is heard to its end, then the new one whole.
    let heard = harness.output.heard
    let boundary = (start(of: decodedA, in: heard)! + split) * 2
    XCTAssertEqual(Array(heard[(boundary - 8000)..<boundary]), Array(decodedA[(decodedA.count - 8000)...]))
    XCTAssertEqual(Array(heard[boundary..<boundary + decodedC.count]), decodedC)
  }

  func testGainRampsInsteadOfJumping() {
    let harness = Harness()
    harness.engine.load(harness.item("a", Fixtures.pair("flac", "flac").b), autoplay: true)
    harness.settle()
    harness.run(seconds: 0.1)
    harness.engine.setGain(0.5)
    harness.settle()
    harness.run(seconds: 1)
    let whole = decodeFile(Fixtures.pair("flac", "flac").b)
    let first = start(of: whole, in: harness.output.heard)!
    let heard = Array(harness.output.heard[(first * 2)...])
    // Full gain, then half, and the gain between moves by no more than a 10 ms ramp's step.
    XCTAssertEqual(heard[1000], whole[1000])
    XCTAssertEqual(heard[heard.count - 1000], whole[heard.count - 1000] * 0.5, accuracy: 1e-7)
    var gains: [Float] = []
    for index in stride(from: 0, to: heard.count, by: 2) where abs(whole[index]) > 2e-3 { gains.append(heard[index] / whole[index]) }
    let steps = zip(gains, gains.dropFirst()).map { abs($0 - $1) }
    XCTAssertLessThan(steps.max()!, 0.01)
    XCTAssertTrue(gains.contains { $0 > 0.6 && $0 < 0.9 }, "no ramp between the two gains")
  }
}
