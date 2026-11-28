import Accelerate
import XCTest
@testable import SquirmyAudioCore

/// The equalizer, measured with sine sweeps through its own processing, and in the engine.
final class EqualizerTests: XCTestCase {
  private let rates = [44_100.0, 48_000.0]

  /// The app's presets (`apps/mobile/src/player/engine/equalizer.ts`) and some custom curves.
  private let curves: [(name: String, bands: [Float])] = [
    ("bass boost", [6, 5.5, 4.5, 3, 1.5, 0, 0, 0, 0, 0]),
    ("bass reducer", [-6, -5.5, -4.5, -3, -1.5, 0, 0, 0, 0, 0]),
    ("treble boost", [0, 0, 0, 0, 0, 0.5, 1.5, 3, 4.5, 6]),
    ("vocal", [-2, -2, -1, 0, 1.5, 3, 3.5, 2.5, 1, 0]),
    ("late night", [5, 4, 2.5, 1, 0, 0, 0, 1, 2.5, 4]),
    ("every band up", [6, 6, 6, 6, 6, 6, 6, 6, 6, 6]),
    ("smile", [12, 8, 3, -2, -6, -6, -2, 3, 8, 12]),
    ("steps", [-12, -12, -12, 0, 0, 0, 0, 12, 12, 12]),
    ("one band", [0, 0, 0, 0, 0, 12, 0, 0, 0, 0]),
    ("alternating", [6, -6, 6, -6, 6, -6, 6, -6, 6, -6]),
  ]

  func testEachBandAloneGivesItsGainAtItsCentre() {
    for rate in rates {
      for band in 0..<10 {
        for gain: Float in [12, -12, 3] {
          var bands = [Float](repeating: 0, count: 10)
          bands[band] = gain
          let measured = measuredDb(bands, at: Equalizer.frequencies[band], rate: rate)
          XCTAssertEqual(measured, Double(gain), accuracy: 0.5, "band \(band) at \(gain) dB, \(rate) Hz")
        }
      }
    }
  }

  func testEveryCurveIsWhatItWasSetToAtEachCentre() {
    for rate in rates {
      for (name, bands) in curves {
        for (band, frequency) in Equalizer.frequencies.enumerated() {
          let measured = measuredDb(bands, at: frequency, rate: rate)
          XCTAssertEqual(measured, Double(bands[band]), accuracy: 0.5, "\(name), \(Int(frequency)) Hz at \(rate) Hz")
        }
      }
    }
  }

  func testBetweenTheCentresTheResponseIsTheDesignedCurve() {
    // A third of an octave apart, between the bands as well as on them.
    let frequencies = (0..<31).map { 25 * pow(2, Double($0) / 3) }.filter { $0 < 19_000 }
    // The curves whose filters work hardest: steep, and every band moving.
    for rate in rates {
      for (name, bands) in curves where ["vocal", "smile", "alternating"].contains(name) {
        let sections = EqualizerDesign.sections(bands, sampleRate: rate)
        for frequency in frequencies {
          let designed = EqualizerDesign.responseDb(sections, at: frequency, sampleRate: rate)
          XCTAssertEqual(measuredDb(bands, at: frequency, rate: rate), designed, accuracy: 0.05, "\(name), \(Int(frequency)) Hz at \(rate) Hz")
        }
      }
    }
  }

  func testACurveWithEveryBandAtOneGainIsFlatBetweenTheCentres() {
    for rate in rates {
      let sections = EqualizerDesign.sections([Float](repeating: 6, count: 10), sampleRate: rate)
      // From the lowest centre to the highest, a twelfth of an octave apart.
      for step in 0...108 {
        let frequency = Equalizer.frequencies[0] * pow(2, Double(step) / 12)
        XCTAssertEqual(EqualizerDesign.responseDb(sections, at: frequency, sampleRate: rate), 6, accuracy: 0.5, "\(Int(frequency)) Hz at \(rate) Hz")
      }
    }
  }

  func testOffAndFlatLetTheSamplesThroughUntouched() {
    let signal = sweep(rate: 48_000, seconds: 0.5)
    for curve in [nil, EqualizerCurve(bandsDb: [Float](repeating: 0, count: 10), preampDb: 0)] {
      var equalizer = Equalizer(sampleRate: 48_000)
      equalizer.set(curve)
      XCTAssertFalse(equalizer.isActive)
      var samples = signal
      equalizer.process(&samples)
      XCTAssertEqual(samples, signal)
    }
  }

  func testThePreampTurnsEverythingDown() {
    let rate = 48_000.0
    let measured = measuredDb([Float](repeating: 0, count: 10), preamp: -6, at: 1_000, rate: rate)
    XCTAssertEqual(measured, -6, accuracy: 0.01)
    XCTAssertEqual(measuredDb([0, 0, 0, 0, 0, 6, 0, 0, 0, 0], preamp: -6, at: 1_000, rate: rate), 0, accuracy: 0.5)
  }

  func testTheLengthOfEachRunMakesNoDifference() {
    let rate = 44_100.0
    let signal = sweep(rate: rate, seconds: 1)
    let curve = EqualizerCurve(bandsDb: curves[6].bands, preampDb: -12)
    XCTAssertLessThan(maxDifference(equalize(signal, curve, rate: rate, chunk: 4096)[...], equalize(signal, curve, rate: rate, chunk: 333)[...]), 1e-5)
  }

  func testAChangeMidSongIsCrossfadedInsteadOfStepping() {
    let rate = 48_000.0
    let signal = tone(1_000, rate: rate, seconds: 1).map { $0 * 0.2 }
    let boosted = EqualizerCurve(bandsDb: [0, 0, 0, 0, 0, 12, 0, 0, 0, 0], preampDb: 0)
    for (from, to) in [(nil, boosted), (boosted, nil), (boosted, EqualizerCurve(bandsDb: [0, 0, 0, 0, 0, -12, 0, 0, 0, 0], preampDb: 0))] {
      var equalizer = Equalizer(sampleRate: rate)
      equalizer.set(from)
      var out: [Float] = []
      let change = Int(rate / 2)
      var frame = 0
      while frame < signal.count / 2 {
        if frame == change { equalizer.set(to) }
        let end = min(signal.count / 2, frame + 1000)
        var run = Array(signal[frame * 2..<end * 2])
        equalizer.process(&run)
        out += run
        frame = end
      }
      // Each sample moves from the last by at most the steepest the louder tone moves, plus
      // its share of the level changing over 10 ms: a step would move by up to the whole difference.
      let louder = Float(0.2 * 4)
      let slope = louder * Float(2 * Double.pi * 1_000 / rate)
      let levelStep = louder / Float(rate * Equalizer.transitionSeconds)
      let left = channel(out, 0)
      let steps = zip(left, left.dropFirst()).map { abs($1 - $0) }
      XCTAssertLessThan(steps.max()!, (slope + levelStep) * 1.1, "\(String(describing: from?.bandsDb[5])) → \(String(describing: to?.bandsDb[5])) dB")
      // And it gets there.
      let settled = rms(Array(out[(change + Int(rate * 0.1)) * 2..<(change + Int(rate * 0.2)) * 2]))
      let expected = Double(rms(Array(signal[0..<9600]))) * pow(10, Double(to?.bandsDb[5] ?? 0) / 20)
      XCTAssertEqual(Double(settled), expected, accuracy: expected * 0.06)
    }
  }

  // MARK: - In the engine

  func testTheEngineEqualizesWhatItPlaysAndStaysGapless() {
    let rate = Fixtures.rate
    let curve = EqualizerCurve(bandsDb: curves[4].bands, preampDb: -5)
    let harness = Harness()
    let pair = Fixtures.pair("flac", "flac")
    harness.engine.setEqualizer(curve)
    harness.engine.load(harness.item("a", pair.a), autoplay: false)
    harness.engine.preload(harness.item("b", pair.b))
    harness.settle()
    harness.engine.play()
    harness.settle()
    harness.run(seconds: 3.4)
    XCTAssertEqual(harness.ended, ["a", "b"])
    XCTAssertEqual(harness.output.heardFrom, 0)
    // The uncut original through one equalizer: the boundary leaves no trace.
    let expected = equalize(Fixtures.reference, curve, rate: rate, chunk: 4096)
    let heard = Array(harness.output.heard.prefix(expected.count))
    XCTAssertEqual(heard.count, expected.count)
    XCTAssertLessThan(maxDifference(heard[...], expected[...]), 1e-6)
  }

  func testTheEngineHearsAChangeAfterItsLead() {
    let harness = Harness()
    let pair = Fixtures.pair("flac", "flac")
    harness.engine.load(harness.item("a", pair.a), autoplay: true)
    harness.settle()
    harness.run(seconds: 0.5)
    harness.engine.setEqualizer(EqualizerCurve(bandsDb: [Float](repeating: 0, count: 10), preampDb: -6))
    harness.run(seconds: 0.8)
    let heard = harness.output.heard
    let first = start(of: decodeFile(pair.a), in: heard)!
    let original = decodeFile(pair.a)
    // Untouched up to the change, half as loud from a lead later.
    let changedAt = Int(Fixtures.rate * 0.5)
    XCTAssertEqual(Array(heard[first * 2..<(first + changedAt) * 2]), Array(original[0..<changedAt * 2]))
    let later = Int(Fixtures.rate * 1.0)
    let ratio = rms(Array(heard[(first + later) * 2..<(first + later + 2048) * 2])) / rms(Array(original[later * 2..<(later + 2048) * 2]))
    XCTAssertEqual(Double(ratio), 0.501, accuracy: 0.01)
  }

  // MARK: - Helpers

  /// The response at `frequency` in dB, measured with a sine through an equalizer.
  private func measuredDb(_ bands: [Float], preamp: Float = 0, at frequency: Double, rate: Double) -> Double {
    let input = tone(frequency, rate: rate, seconds: 0.7).map { $0 * 0.1 }
    let output = equalize(input, EqualizerCurve(bandsDb: bands, preampDb: preamp), rate: rate, chunk: 2048)
    // Once the filters have settled, over whole periods.
    let from = Int(rate * 0.3)
    let periods = (0.35 * frequency).rounded(.up)
    let to = from + Int((periods / frequency * rate).rounded())
    return 20 * log10(Double(rms(Array(output[from * 2..<to * 2])) / rms(Array(input[from * 2..<to * 2]))))
  }

  private func equalize(_ samples: [Float], _ curve: EqualizerCurve, rate: Double, chunk: Int) -> [Float] {
    var equalizer = Equalizer(sampleRate: rate)
    equalizer.set(curve)
    // From the first frame, as the engine starts a curve set before it plays.
    equalizer.reset()
    var out: [Float] = []
    var frame = 0
    while frame < samples.count / 2 {
      let end = min(samples.count / 2, frame + chunk)
      var run = Array(samples[frame * 2..<end * 2])
      equalizer.process(&run)
      out += run
      frame = end
    }
    return out
  }
}
