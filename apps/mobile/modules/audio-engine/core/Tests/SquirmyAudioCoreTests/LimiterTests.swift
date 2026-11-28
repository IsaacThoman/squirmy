import Accelerate
import XCTest
@testable import SquirmyAudioCore

/// The limiter at the end of the chain, on its own and in the engine.
final class LimiterTests: XCTestCase {
  private let ceiling = Double(Limiter.ceilingDb)

  func testATwelveDecibelBoostOfAFullScaleToneStaysUnderTheCeiling() {
    for rate in [44_100.0, 48_000.0] {
      for frequency in [60.0, 1_000.0, 9_000.0] {
        let boosted = tone(frequency, rate: rate, seconds: 1.5).map { $0 * db(12) }
        let limited = limit(boosted, rate: rate)
        let peak = truePeakDb(limited)
        XCTAssertLessThan(peak, ceiling, "\(frequency) Hz at \(rate) Hz")
        // Down to the ceiling, not far below it.
        XCTAssertGreaterThan(peak, ceiling - 0.5, "\(frequency) Hz at \(rate) Hz")
      }
    }
  }

  func testCatchesPeaksBetweenTheSamples() {
    // A quarter of the sample rate, 45° off the samples: every sample is 3 dB under the wave's
    // own peak, so a limiter that read the samples alone would let it through 3 dB over.
    let rate = 44_100.0
    let wave = tone(rate / 4, rate: rate, seconds: 1, phase: .pi / 4)
    // (A little more at its abrupt ends.)
    XCTAssertGreaterThan(sampleTruePeakGapDb(wave), 2.95)
    let limited = limit(wave.map { $0 * db(1) }, rate: rate)
    XCTAssertLessThan(truePeakDb(limited), ceiling)
  }

  func testASignalUnderTheCeilingPassesBitIdentical() {
    let rate = 48_000.0
    // Quiet, and just under the ceiling (which the quick check cannot clear, so every peak is
    // looked at, and none needs turning down).
    for level in [-40.0, -1.6] {
      let signal = sweep(rate: rate, seconds: 2).map { $0 * db(level) }
      XCTAssertLessThan(truePeakDb(signal), ceiling - 0.1)
      XCTAssertEqual(limit(signal, rate: rate), signal, "\(level) dB")
    }
  }

  func testComesBackToUntouchedAfterAPeak() {
    let rate = 48_000.0
    var signal = sweep(rate: rate, seconds: 4).map { $0 * db(-20) }
    // A loud second, 6 dB over full scale, with two quiet ones after it.
    let burst = Int(rate) * 2..<Int(rate) * 4
    for index in burst { signal[index] *= db(26) }
    let limited = limit(signal, rate: rate)
    XCTAssertLessThan(truePeakDb(limited), ceiling)
    // Untouched until the lookahead before the burst, and again once it has recovered.
    let before = (burst.lowerBound / 2 - 200) * 2
    XCTAssertEqual(Array(limited[..<before]), Array(signal[..<before]))
    let after = (burst.upperBound / 2 + Int(rate * 1.2)) * 2
    XCTAssertEqual(Array(limited[after...]), Array(signal[after...]), "the gain did not come back to exactly 1")
    XCTAssertNotEqual(Array(limited[burst]), Array(signal[burst]))
  }

  func testRampsDownAheadOfAPeakInsteadOfJumping() {
    let rate = 48_000.0
    // A quiet tone that becomes 12 dB over the ceiling from one sample to the next.
    var signal = tone(440, rate: rate, seconds: 1).map { $0 * db(-12) }
    let step = Int(rate / 2)
    for index in step * 2..<signal.count { signal[index] *= db(24) }
    let limited = limit(signal, rate: rate)
    XCTAssertLessThan(truePeakDb(limited), ceiling)
    let gains = gainsApplied(limited, signal)
    let lookahead = Int((0.0015 * rate).rounded())
    let changes = zip(gains, gains.dropFirst()).map { abs($0.1.gain - $0.0.gain) / Float($0.1.frame - $0.0.frame) }
    // From 1 to about a quarter: spread over the lookahead, not in one sample.
    XCTAssertLessThan(changes.max()!, 1.5 / Float(lookahead))
    XCTAssertTrue(gains.contains { $0.frame < step && $0.gain < 0.9 }, "it did not turn down ahead of the step")
  }

  func testHoldsSteadyOnASustainedToneWithoutPumping() {
    let rate = 48_000.0
    for frequency in [60.0, 1_000.0] {
      let signal = tone(frequency, rate: rate, seconds: 2).map { $0 * db(12) }
      let gains = gainsApplied(limit(signal, rate: rate), signal).filter { $0.frame > Int(rate * 0.2) }.map(\.gain)
      let swing = 20 * log10(Double(gains.max()! / gains.min()!))
      XCTAssertLessThan(swing, 0.05, "\(frequency) Hz: the gain moves with the waveform")
    }
  }

  func testTheLengthOfEachRunMakesNoDifference() {
    let rate = 44_100.0
    let signal = sweep(rate: rate, seconds: 2).map { $0 * db(9) }
    let long = limit(signal, rate: rate, chunk: 4096)
    let short = limit(signal, rate: rate, chunk: 333)
    XCTAssertLessThan(maxDifference(long[...], short[...]), 1e-6)
  }

  // MARK: - In the engine

  func testTheEngineLimitsABoostedEntryAndKeepsItGapless() {
    // The fixtures' sweep is at −40 dB: +52 dB makes it a full-scale sweep boosted 12 dB.
    let harness = playPair(gain: db(52))
    XCTAssertEqual(harness.ended, ["a", "b"])
    // Loaded paused, so the first frame heard is the first entry's first.
    XCTAssertEqual(harness.output.heardFrom, 0)
    let played = Array(harness.output.heard.prefix(Fixtures.reference.count))
    XCTAssertEqual(played.count, Fixtures.reference.count)
    XCTAssertLessThan(truePeakDb(played), ceiling)
    XCTAssertGreaterThan(truePeakDb(played), ceiling - 0.5)
    // The same sweep, one sample to the next across the boundary: nothing added or lost.
    let lag = bestLag(channel(played, 0), channel(Fixtures.reference, 0), refStart: Fixtures.splitFrame + 2048, start: Fixtures.splitFrame + 2048, maxLag: 50)
    XCTAssertEqual(lag, 0)
  }

  func testTheEnginePassesAnEntryUnderTheCeilingBitIdentical() {
    // Turned up 6 dB, the −40 dB sweep is still far under the ceiling.
    let harness = playPair(gain: 2)
    XCTAssertEqual(harness.output.heardFrom, 0)
    let expected = Fixtures.reference.map { $0 * 2 }
    XCTAssertEqual(Array(harness.output.heard.prefix(expected.count)), expected)
  }

  // MARK: - Helpers

  /// Runs `samples` through a limiter `chunk` frames at a time, each with what follows it as
  /// its lookahead, as the engine does.
  private func limit(_ samples: [Float], rate: Double, chunk: Int = 2048) -> [Float] {
    var limiter = Limiter(sampleRate: rate)
    var out: [Float] = []
    var frame = 0
    let frames = samples.count / 2
    while frame < frames {
      let end = min(frames, frame + chunk)
      var run = Array(samples[frame * 2..<end * 2])
      let ahead = samples[end * 2..<min(frames, end + limiter.aheadFrames) * 2]
      limiter.process(&run, ahead: ahead)
      out += run
      frame = end
    }
    return out
  }

  /// The gain each frame was played at, where the input is loud enough to tell.
  private func gainsApplied(_ output: [Float], _ input: [Float]) -> [(frame: Int, gain: Float)] {
    stride(from: 0, to: input.count, by: 2).compactMap { index in
      abs(input[index]) > 0.05 ? (index / 2, output[index] / input[index]) : nil
    }
  }

  /// The two halves of the FLAC sweep at `gain`, loaded paused, then played to the end.
  private func playPair(gain: Float) -> Harness {
    let harness = Harness()
    let pair = Fixtures.pair("flac", "flac")
    harness.engine.load(harness.item("a", pair.a, gain: gain), autoplay: false)
    harness.engine.preload(harness.item("b", pair.b, gain: gain))
    harness.settle()
    harness.engine.play()
    harness.settle()
    harness.run(seconds: 3.4)
    return harness
  }
}

/// A gain of `value` decibels.
private func db(_ value: Double) -> Float { Float(pow(10, value / 20)) }

/// A full-scale sine on both channels.
private func tone(_ frequency: Double, rate: Double, seconds: Double, phase: Double = 0) -> [Float] {
  (0..<Int(rate * seconds)).flatMap { frame -> [Float] in
    let value = Float(sin(2 * .pi * frequency * Double(frame) / rate + phase))
    return [value, value]
  }
}

/// A full-scale sweep, a different one on each channel, like the fixtures'.
private func sweep(rate: Double, seconds: Double) -> [Float] {
  func at(_ t: Double, _ from: Double, _ to: Double) -> Float {
    Float(sin(2 * .pi * (from * t + (to - from) / (2 * seconds) * t * t)))
  }
  return (0..<Int(rate * seconds)).flatMap { frame -> [Float] in
    let t = Double(frame) / rate
    return [at(t, 220, 1760), at(t, 1320, 330)]
  }
}

/// How far the true peak is over the largest sample, in dB.
private func sampleTruePeakGapDb(_ samples: [Float]) -> Double {
  let largest = Double(samples.map(abs).max()!)
  return truePeakDb(samples) - 20 * log10(largest)
}

/**
 * The true peak of interleaved stereo, in dBTP, 4× oversampled as BS.1770 measures it. Its
 * interpolator is its own, four times as long as the limiter's, so the two do not share
 * their mistakes.
 */
func truePeakDb(_ samples: [Float]) -> Double {
  let reach = 32
  let kernels: [[Double]] = [0.25, 0.5, 0.75].map { offset in
    let taps = (0..<reach * 2).map { index -> Double in
      let distance = Double(index - (reach - 1)) - offset
      let sinc = sin(.pi * distance) / (.pi * distance)
      let edge = distance / Double(reach)
      return sinc * besselI0(9 * (1 - edge * edge).squareRoot())
    }
    let total = taps.reduce(0, +)
    return taps.map { $0 / total }
  }
  var peak = 0.0
  for index in 0..<2 {
    let signal = [Double](repeating: 0, count: reach) + channel(samples, index).map(Double.init) + [Double](repeating: 0, count: reach)
    let frames = signal.count - reach * 2 + 1
    var points = [Double](repeating: 0, count: frames)
    for kernel in kernels {
      vDSP_convD(signal, 1, kernel, 1, &points, 1, vDSP_Length(frames), vDSP_Length(kernel.count))
      peak = max(peak, points.map(abs).max()!)
    }
    peak = max(peak, signal.map(abs).max()!)
  }
  return 20 * log10(peak)
}

private func besselI0(_ x: Double) -> Double {
  var sum = 1.0
  var term = 1.0
  for k in 1..<40 {
    term *= (x / 2) * (x / 2) / Double(k * k)
    sum += term
  }
  return sum
}
