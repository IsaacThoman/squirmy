import Accelerate
import Foundation

/**
 * The true-peak limiter at the end of the engine's chain. It keeps every peak, between the
 * samples as well as on them, under `ceilingDb` (−1 dBTP), so that normalization can turn a
 * quiet song up without clipping.
 *
 * - **Peaks** are found 4× oversampled: three points between each pair of frames, read
 *   through a windowed-sinc interpolator, as well as the frames themselves.
 * - **Lookahead.** The gain needed for a peak is held for `hold` and then averaged over the
 *   `lookahead` (1.5 ms) before it, so the gain ramps down ahead of a peak instead of jumping,
 *   and is down all the way when the peak plays. The hold also keeps the gain still between
 *   the peaks of a low note, which would otherwise make it ripple.
 * - **Release** over 50 to 150 ms, slower the more it was turning down, so a deep reduction
 *   comes back without pumping and a light one without lingering.
 * - **Transparent at rest.** While nothing goes over, its gain is exactly 1 and the samples
 *   pass untouched, bit for bit; after a peak it comes back to exactly 1.
 *
 * It adds no delay: what it looks ahead into is handed to it with each run of frames
 * (`ahead`, the frames the engine queues next), so the timeline, gapless boundaries and the
 * clock are the same with it as without. Frames it is not given count as silence, which is
 * right at the end of what plays and costs only smoothness when decoding is behind.
 */
struct Limiter {
  static let ceilingDb: Float = -1
  /// 4× oversampling can miss part of a peak on the highest frequencies; it aims this far
  /// under the ceiling for that.
  static let marginDb: Float = 0.1

  /// Frames each side of an interpolated point that the interpolator reads.
  private static let reach = 8
  private static let lookaheadSeconds = 0.0015
  private static let holdSeconds = 0.01
  private static let releaseSeconds = (fast: 0.05, slow: 0.15)
  /// The reduction at which the release is slowest: 6 dB, a gain of one half.
  private static let slowestAt = 0.5

  let sampleRate: Double
  /// Frames the gain ramps over ahead of a peak.
  let lookahead: Int
  /// Frames the gain needed for a peak is held for.
  let hold: Int
  /// How many frames `process` wants in `ahead`: its lookahead and the interpolator's reach.
  var aheadFrames: Int { lookahead + Self.reach - 1 }

  private let aim: Float
  /// The interpolator, one kernel for each point between two frames (a quarter, half and
  /// three quarters of the way), each `2 * reach` taps from `reach - 1` frames before.
  private let kernels: [[Float]]
  /// No interpolated point can be larger than the largest sample times this.
  private let overshoot: Float
  private let releaseFast: Double
  private let releaseSlow: Double

  // Carried from one run of frames to the next.
  /// The last `reach` frames given, interleaved, for the interpolator.
  private var history: [Float]
  /// The gain each of the last `hold - 1` frames needed, for the hold.
  private var needed: [Float]
  private var neededAtRest = true
  /// The held gain at the last frame, which the release continues from. In double precision:
  /// near 1, a float's steps are too coarse for the release to get all the way back.
  private var held: Double = 1

  init(sampleRate: Double) {
    self.sampleRate = sampleRate
    lookahead = max(1, Int((Self.lookaheadSeconds * sampleRate).rounded()))
    hold = max(lookahead, Int((Self.holdSeconds * sampleRate).rounded()))
    aim = powf(10, (Self.ceilingDb - Self.marginDb) / 20)
    kernels = [0.25, 0.5, 0.75].map { Self.kernel(at: $0) }
    overshoot = max(1, kernels.map { $0.reduce(0) { $0 + abs($1) } }.max()!)
    releaseFast = exp(-1 / (Self.releaseSeconds.fast * sampleRate))
    releaseSlow = exp(-1 / (Self.releaseSeconds.slow * sampleRate))
    history = [Float](repeating: 0, count: Self.reach * 2)
    needed = [Float](repeating: 1, count: hold - 1)
  }

  /// The gain it is recovering from: 1 at rest.
  var gain: Float { Float(held) }

  /// Starts again with nothing before, as for a seek. `gain` carries on from a gain it was at
  /// when rendering again part way, so the release does not restart.
  mutating func reset(gain: Float = 1) {
    for index in history.indices { history[index] = 0 }
    for index in needed.indices { needed[index] = 1 }
    neededAtRest = true
    held = Double(min(1, max(0, gain)))
  }

  /// Frames that play without it (an entry at unity gain): it is at rest after them, with
  /// them as what came before.
  mutating func pass(_ samples: ArraySlice<Float>) {
    reset()
    remember(samples)
  }

  /// Limits interleaved stereo `samples` in place. `ahead` are the frames that follow them, as
  /// many of `aheadFrames` as are known.
  mutating func process(_ samples: inout [Float], ahead: ArraySlice<Float>) {
    let count = samples.count / 2
    guard count > 0 else { return }
    let reach = Self.reach
    let extra = aheadFrames
    // What came before, the frames, and what follows (silence where it is not known).
    var signal = [Float](repeating: 0, count: (reach + count + extra) * 2)
    signal.replaceSubrange(0..<reach * 2, with: history)
    signal.replaceSubrange(reach * 2..<(reach + count) * 2, with: samples)
    let known = min(ahead.count / 2, extra) * 2
    if known > 0 { signal.replaceSubrange((reach + count) * 2..<(reach + count) * 2 + known, with: ahead.prefix(known)) }
    defer { remember(signal[count * 2..<(count + reach) * 2]) }

    var loudest: Float = 0
    vDSP_maxmgv(signal, 1, &loudest, vDSP_Length(signal.count))
    if held == 1, neededAtRest, loudest * overshoot <= aim {
      // Nothing near the ceiling, and nothing to recover from.
      return
    }

    // The gain each frame needs: the aim over its peak, between it and its neighbours.
    let span = lookahead - 1
    let frames = count + span
    let peaks = truePeaks(signal, frames + 1)
    var need = [Float](repeating: 0, count: frames)
    var aim = self.aim
    var floor: Float = 0
    var unity: Float = 1
    peaks.withUnsafeBufferPointer { peaks in
      need.withUnsafeMutableBufferPointer { need in
        let out = need.baseAddress!
        vDSP_vmax(peaks.baseAddress!, 1, peaks.baseAddress! + 1, 1, out, 1, vDSP_Length(frames))
        // Over a silent frame, infinity, which the clip makes 1.
        vDSP_svdiv(&aim, out, 1, out, 1, vDSP_Length(frames))
        vDSP_vclip(out, 1, &floor, &unity, out, 1, vDSP_Length(frames))
      }
    }

    // Held for `hold`, then released. A held gain is at most what each frame in the hold
    // before it needs, so the average of those after a frame, below, is at most what that
    // frame needs: the peak is down to the aim when it plays.
    let window = needed + need
    let heldGains = slidingMinimum(window, length: hold)
    var gains = [Float](repeating: 1, count: frames)
    var level = held
    for index in 0..<frames {
      if level < 1 {
        let depth = min(1, (1 - level) / (1 - Self.slowestAt))
        let coefficient = releaseFast + (releaseSlow - releaseFast) * depth
        level = 1 - (1 - level) * coefficient
        // Back at rest exactly, so what follows passes untouched.
        if level > 1 - 1e-6 { level = 1 }
      }
      level = min(level, Double(heldGains[index]))
      gains[index] = Float(level)
      if index == count - 1 { held = level }
    }
    needed = Array(window[count..<count + hold - 1])
    var least: Float = 1
    vDSP_minv(needed, 1, &least, vDSP_Length(needed.count))
    neededAtRest = least == 1

    // The gain at each frame: the average over the lookahead after it.
    var sum = 0.0
    var under = 0
    for index in 0..<lookahead {
      sum += Double(gains[index])
      if gains[index] < 1 { under += 1 }
    }
    samples.withUnsafeMutableBufferPointer { out in
      for frame in 0..<count {
        if under > 0 {
          let gain = min(1, Float(sum / Double(lookahead)))
          out[frame * 2] *= gain
          out[frame * 2 + 1] *= gain
        }
        guard frame + 1 < count else { break }
        let leaving = gains[frame]
        let entering = gains[frame + lookahead]
        sum += Double(entering) - Double(leaving)
        under += (entering < 1 ? 1 : 0) - (leaving < 1 ? 1 : 0)
      }
    }
  }

  /// The largest of each frame and the three interpolated points before it, over both
  /// channels, for the first `frames` frames of `signal` after its history.
  private func truePeaks(_ signal: [Float], _ frames: Int) -> [Float] {
    let reach = Self.reach
    let length = vDSP_Length(frames)
    var peaks = [Float](repeating: 0, count: frames)
    var points = [Float](repeating: 0, count: frames)
    signal.withUnsafeBufferPointer { input in
      peaks.withUnsafeMutableBufferPointer { peaks in
        points.withUnsafeMutableBufferPointer { points in
          let peak = peaks.baseAddress!
          let point = points.baseAddress!
          for channel in 0..<2 {
            let start = input.baseAddress! + channel
            for kernel in kernels {
              // Point `i` lies between frames `i - 1` and `i` after the history; its taps
              // start `reach - 1` frames before the first of them.
              vDSP_conv(start, 2, kernel, 1, point, 1, length, vDSP_Length(kernel.count))
              vDSP_vabs(point, 1, point, 1, length)
              vDSP_vmax(peak, 1, point, 1, peak, 1, length)
            }
            vDSP_vabs(start + reach * 2, 2, point, 1, length)
            vDSP_vmax(peak, 1, point, 1, peak, 1, length)
          }
        }
      }
    }
    return peaks
  }

  private mutating func remember(_ samples: ArraySlice<Float>) {
    let keep = history.count
    if samples.count >= keep {
      history = Array(samples.suffix(keep))
    } else {
      history = Array((history + samples).suffix(keep))
    }
  }

  /// A Kaiser-windowed sinc for the point `offset` (0 to 1) of the way from one frame to the
  /// next, with unity gain at 0 Hz.
  private static func kernel(at offset: Double) -> [Float] {
    let beta = 6.0
    let taps = (0..<(reach * 2)).map { index -> Double in
      let distance = Double(index - (reach - 1)) - offset
      let sinc = distance == 0 ? 1 : sin(Double.pi * distance) / (Double.pi * distance)
      let edge = distance / Double(reach)
      return sinc * besselI0(beta * (1 - edge * edge).squareRoot()) / besselI0(beta)
    }
    let total = taps.reduce(0, +)
    return taps.map { Float($0 / total) }
  }

  private static func besselI0(_ x: Double) -> Double {
    var sum = 1.0
    var term = 1.0
    for k in 1..<32 {
      term *= (x / 2) * (x / 2) / Double(k * k)
      sum += term
      if term < sum * 1e-12 { break }
    }
    return sum
  }
}

/// The smallest of each `length` consecutive values: `values.count - length + 1` of them, in
/// linear time (van Herk and Gil-Werman).
func slidingMinimum(_ values: [Float], length: Int) -> [Float] {
  let count = values.count - length + 1
  guard count > 0 else { return [] }
  guard length > 1 else { return values }
  let total = values.count
  var prefix = values
  var suffix = values
  var block = 0
  while block < total {
    let end = min(block + length, total)
    for index in block + 1..<end { prefix[index] = min(prefix[index - 1], values[index]) }
    var index = end - 2
    while index >= block {
      suffix[index] = min(suffix[index + 1], values[index])
      index -= 1
    }
    block = end
  }
  return (0..<count).map { min(suffix[$0], prefix[$0 + length - 1]) }
}
