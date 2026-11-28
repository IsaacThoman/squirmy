import Accelerate
import Foundation

/// What the equalizer is set to: a gain for each of `Equalizer.frequencies` and the preamp, in dB.
struct EqualizerCurve: Equatable {
  var bandsDb: [Float]
  var preampDb: Float
}

/**
 * The 10-band equalizer, between the entries' gain and the limiter: one peaking biquad per
 * band (the RBJ cookbook's), cascaded through Accelerate's `vDSP_biquad`, and the preamp.
 *
 * - **What you set is what you get.** Neighbouring bands overlap, so a filter set to a band's
 *   gain would not give that gain at the band's centre once its neighbours are set too (two
 *   +6 dB neighbours lift each other by about 1.5 dB). `EqualizerDesign` solves for the
 *   filters' gains that give each band's own gain at its centre.
 * - **Changes do not click.** A new curve's filters start from the old ones' state and the two
 *   outputs are crossfaded over `transitionSeconds`; one change finishes before the next starts.
 * - **Off is untouched.** With no curve, or a flat one at 0 dB, the samples pass bit for bit.
 *
 * A value type, so the engine can keep its state with each run of frames it queues and look
 * ahead through a copy for the limiter.
 */
struct Equalizer {
  /// The bands' centres, an octave apart: 31 Hz to 16 kHz.
  static let frequencies: [Double] = (0..<10).map { 31.25 * pow(2, Double($0)) }
  /// The range a band's gain is set in.
  static let rangeDb: Float = 12
  static let transitionSeconds = 0.01

  let sampleRate: Double
  /// What it is set to; what it plays once any change is over.
  private(set) var target: EqualizerCurve?
  /// The curve of `path`.
  private var curve: EqualizerCurve?
  private var path: Path
  /// The path a change crossfades from, and how far it has got.
  private var fading: (from: Path, done: Int)?
  /// The two last frames given, `[left(n-2), left(n-1), right(n-2), right(n-1)]`, for filters
  /// starting part way: as if they had been running, letting the signal through unchanged.
  private var last: [Float] = [0, 0, 0, 0]
  private let transitionFrames: Int

  init(sampleRate: Double) {
    self.sampleRate = sampleRate
    path = Path.dry
    transitionFrames = max(1, Int((Self.transitionSeconds * sampleRate).rounded()))
  }

  /// Whether the next frames go through filters or a gain: false while it lets them through.
  var isActive: Bool { fading != nil || !path.isDry || normalized(target) != curve }

  /// Sets the curve; `nil` turns it off. Heard from the next frames processed, crossfaded.
  mutating func set(_ curve: EqualizerCurve?) {
    target = curve
  }

  /// Forgets what came before, as for a new start after silence: filters at rest.
  mutating func reset() {
    if fading != nil || normalized(target) != curve {
      curve = normalized(target)
      path = Path(curve: curve, sampleRate: sampleRate)
      fading = nil
    }
    path.rest()
    last = [0, 0, 0, 0]
  }

  /// Equalizes interleaved stereo `samples` in place.
  mutating func process(_ samples: inout [Float]) {
    let count = samples.count / 2
    guard count > 0 else { return }
    let wanted = normalized(target)
    if fading == nil, wanted != curve {
      let next = Path(curve: wanted, sampleRate: sampleRate, continuing: path, last: last)
      fading = (path, 0)
      path = next
      curve = wanted
    }
    let input = samples
    defer { remember(input) }
    guard var fade = fading else {
      if !path.isDry { path.render(input, into: &samples) }
      return
    }
    var old = input
    fade.from.render(input, into: &old)
    path.render(input, into: &samples)
    let length = transitionFrames
    samples.withUnsafeMutableBufferPointer { out in
      for frame in 0..<min(count, length - fade.done) {
        let mix = Float(fade.done + frame + 1) / Float(length)
        for side in 0..<2 {
          let index = frame * 2 + side
          out[index] = old[index] + (out[index] - old[index]) * mix
        }
      }
    }
    fade.done += count
    fading = fade.done >= length ? nil : fade
  }

  /// A flat curve with no preamp is no curve: it lets the samples through.
  private func normalized(_ curve: EqualizerCurve?) -> EqualizerCurve? {
    guard let curve, curve.preampDb != 0 || curve.bandsDb.contains(where: { $0 != 0 }) else { return nil }
    return curve
  }

  private mutating func remember(_ input: [Float]) {
    let count = input.count / 2
    if count >= 2 {
      last = [input[(count - 2) * 2], input[(count - 1) * 2], input[(count - 2) * 2 + 1], input[(count - 1) * 2 + 1]]
    } else {
      last = [last[1], input[0], last[3], input[1]]
    }
  }
}

/// One way through the equalizer: its filters (none for flat), their state for each channel,
/// and the preamp.
private struct Path {
  static let dry = Path(cascade: nil, gain: 1, delays: [[], []])

  var cascade: Cascade?
  var gain: Float
  /// For each channel, `vDSP_biquad`'s delay line: the last two values into and out of each
  /// section, oldest first (`2 * sections + 2`).
  var delays: [[Float]]

  var isDry: Bool { cascade == nil && gain == 1 }

  init(cascade: Cascade?, gain: Float, delays: [[Float]]) {
    self.cascade = cascade
    self.gain = gain
    self.delays = delays
  }

  /// The path for `curve`. Continuing `old`: with its filters' state where the sections match,
  /// otherwise as if letting `last` through.
  init(curve: EqualizerCurve?, sampleRate: Double, continuing old: Path? = nil, last: [Float] = [0, 0, 0, 0]) {
    guard let curve else {
      self = .dry
      return
    }
    let sections = EqualizerDesign.sections(curve.bandsDb, sampleRate: sampleRate)
    cascade = sections.isEmpty ? nil : Cascade(sections)
    gain = powf(10, curve.preampDb / 20)
    let length = 2 * sections.count + 2
    if let old, old.cascade?.count == sections.count, !sections.isEmpty {
      delays = old.delays
    } else {
      delays = (0..<2).map { side in
        (0..<length).map { index in last[side * 2 + index % 2] }
      }
    }
  }

  mutating func rest() {
    for side in delays.indices { for index in delays[side].indices { delays[side][index] = 0 } }
  }

  /// `input` (interleaved stereo) through the filters and the preamp, into `output`.
  mutating func render(_ input: [Float], into output: inout [Float]) {
    let count = input.count / 2
    guard let cascade else {
      if gain == 1 {
        output = input
      } else {
        var scale = gain
        vDSP_vsmul(input, 1, &scale, &output, 1, vDSP_Length(input.count))
      }
      return
    }
    var scratch = [Float](repeating: 0, count: count)
    var scale = gain
    input.withUnsafeBufferPointer { source in
      output.withUnsafeMutableBufferPointer { out in
        for side in 0..<2 {
          delays[side].withUnsafeMutableBufferPointer { delay in
            vDSP_biquad(cascade.setup, delay.baseAddress!, source.baseAddress! + side, 2, &scratch, 1, vDSP_Length(count))
          }
          // Back into its channel, with the preamp.
          vDSP_vsmul(scratch, 1, &scale, out.baseAddress! + side, 2, vDSP_Length(count))
        }
      }
    }
  }
}

/// A `vDSP_biquad` setup, shared by every copy of the path that uses it.
private final class Cascade {
  let setup: vDSP_biquad_Setup
  let count: Int

  init(_ sections: [[Double]]) {
    count = sections.count
    setup = vDSP_biquad_CreateSetup(sections.flatMap { $0 }, vDSP_Length(sections.count))!
  }

  deinit { vDSP_biquad_DestroySetup(setup) }
}

/**
 * The equalizer's filters for a curve. Each band is a peaking filter at its centre; because
 * the bands overlap, the filters' own gains are solved for, so that the cascade's response at
 * each centre is the band's setting. In decibels the cascade's response is the sum of its
 * filters', which is nearly linear in their gains: a linear solve with the filters' measured
 * interaction, then a few corrections with the exact response, land within a hundredth of a
 * decibel for any curve in range.
 */
enum EqualizerDesign {
  /// Each band's width, in octaves: an octave and a half, so a curve with every band at one
  /// gain is flat between the centres too, within a few tenths of a decibel.
  static let bandwidth = 1.5
  /// A filter's gain is kept within this, however steep the curve.
  static let filterRangeDb = 24.0
  /// Bands this close to half the sample rate (16 kHz at 32 kHz) are left out.
  private static let highest = 0.45
  /// The gain the interaction between the filters is measured at.
  private static let probeDb = 6.0

  /// `[b0, b1, b2, a1, a2]` for each band in use, normalized to `a0 = 1`. Empty for a flat curve.
  static func sections(_ bandsDb: [Float], sampleRate: Double) -> [[Double]] {
    let centres = Equalizer.frequencies.enumerated().filter { $0.element < sampleRate * highest }.map(\.offset)
    let targets = centres.map { Double(max(-Equalizer.rangeDb, min(Equalizer.rangeDb, $0 < bandsDb.count ? bandsDb[$0] : 0))) }
    guard targets.contains(where: { $0 != 0 }) else { return [] }
    let frequencies = centres.map { Equalizer.frequencies[$0] }
    let gains = filterGains(targets, frequencies: frequencies, sampleRate: sampleRate)
    return zip(frequencies, gains).map { peaking(frequency: $0, gainDb: $1, sampleRate: sampleRate) }
  }

  /// The filters' gains that put the cascade's response at each of `frequencies` on `targets`.
  static func filterGains(_ targets: [Double], frequencies: [Double], sampleRate: Double) -> [Double] {
    let count = targets.count
    // How much a decibel of each filter moves the response at each centre.
    var interaction = [[Double]](repeating: [Double](repeating: 0, count: count), count: count)
    for filter in 0..<count {
      let section = peaking(frequency: frequencies[filter], gainDb: probeDb, sampleRate: sampleRate)
      for centre in 0..<count { interaction[centre][filter] = responseDb([section], at: frequencies[centre], sampleRate: sampleRate) / probeDb }
    }
    var gains = solve(interaction, targets) ?? targets
    for _ in 0..<12 {
      gains = gains.map { max(-filterRangeDb, min(filterRangeDb, $0)) }
      let sections = zip(frequencies, gains).map { peaking(frequency: $0, gainDb: $1, sampleRate: sampleRate) }
      let error = (0..<count).map { targets[$0] - responseDb(sections, at: frequencies[$0], sampleRate: sampleRate) }
      if error.allSatisfy({ abs($0) < 0.001 }) { break }
      guard let step = solve(interaction, error) else { break }
      gains = zip(gains, step).map { $0 + $1 }
    }
    return gains.map { max(-filterRangeDb, min(filterRangeDb, $0)) }
  }

  /// The RBJ cookbook's peaking filter, its width given in octaves. The cookbook's correction
  /// for the bilinear transform keeps the highest bands as wide as the others: without it the
  /// 16 kHz band narrows towards half the sample rate and leaves a dip below it.
  static func peaking(frequency: Double, gainDb: Double, sampleRate: Double) -> [Double] {
    let amplitude = pow(10, gainDb / 40)
    let omega = 2 * Double.pi * frequency / sampleRate
    let alpha = sin(omega) * sinh(log(2) / 2 * bandwidth * omega / sin(omega))
    let cosine = cos(omega)
    let a0 = 1 + alpha / amplitude
    return [(1 + alpha * amplitude) / a0, -2 * cosine / a0, (1 - alpha * amplitude) / a0, -2 * cosine / a0, (1 - alpha / amplitude) / a0]
  }

  /// The cascade's gain at `frequency`, in dB.
  static func responseDb(_ sections: [[Double]], at frequency: Double, sampleRate: Double) -> Double {
    let omega = 2 * Double.pi * frequency / sampleRate
    let (c1, c2) = (cos(omega), cos(2 * omega))
    return sections.reduce(0) { total, s in
      let numerator = s[0] * s[0] + s[1] * s[1] + s[2] * s[2] + 2 * (s[0] * s[1] + s[1] * s[2]) * c1 + 2 * s[0] * s[2] * c2
      let denominator = 1 + s[3] * s[3] + s[4] * s[4] + 2 * (s[3] + s[3] * s[4]) * c1 + 2 * s[4] * c2
      return total + 10 * log10(numerator / denominator)
    }
  }

  /// `matrix · x = vector` by Gaussian elimination with partial pivoting; nil when singular.
  private static func solve(_ matrix: [[Double]], _ vector: [Double]) -> [Double]? {
    let count = vector.count
    var a = matrix
    var b = vector
    for column in 0..<count {
      let pivot = (column..<count).max { abs(a[$0][column]) < abs(a[$1][column]) }!
      guard abs(a[pivot][column]) > 1e-12 else { return nil }
      a.swapAt(column, pivot)
      b.swapAt(column, pivot)
      for row in column + 1..<count {
        let factor = a[row][column] / a[column][column]
        for k in column..<count { a[row][k] -= factor * a[column][k] }
        b[row] -= factor * b[column]
      }
    }
    var x = [Double](repeating: 0, count: count)
    for row in stride(from: count - 1, through: 0, by: -1) {
      let rest = (row + 1..<count).reduce(0) { $0 + a[row][$1] * x[$1] }
      x[row] = (b[row] - rest) / a[row][row]
    }
    return x
  }
}
