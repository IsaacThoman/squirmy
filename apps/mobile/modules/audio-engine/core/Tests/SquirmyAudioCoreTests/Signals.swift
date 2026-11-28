import Accelerate
import Foundation

// Test signals, made in memory: nothing is played out loud.

/// A gain of `value` decibels.
func db(_ value: Double) -> Float { Float(pow(10, value / 20)) }

/// A full-scale sine on both channels.
func tone(_ frequency: Double, rate: Double, seconds: Double, phase: Double = 0) -> [Float] {
  (0..<Int(rate * seconds)).flatMap { frame -> [Float] in
    let value = Float(sin(2 * .pi * frequency * Double(frame) / rate + phase))
    return [value, value]
  }
}

/// A full-scale sweep, a different one on each channel, like the fixtures'.
func sweep(rate: Double, seconds: Double) -> [Float] {
  func at(_ t: Double, _ from: Double, _ to: Double) -> Float {
    Float(sin(2 * .pi * (from * t + (to - from) / (2 * seconds) * t * t)))
  }
  return (0..<Int(rate * seconds)).flatMap { frame -> [Float] in
    let t = Double(frame) / rate
    return [at(t, 220, 1760), at(t, 1320, 330)]
  }
}

/// The RMS level of `samples`.
func rms(_ samples: [Float]) -> Float {
  var value: Float = 0
  vDSP_rmsqv(samples, 1, &value, vDSP_Length(samples.count))
  return value
}
