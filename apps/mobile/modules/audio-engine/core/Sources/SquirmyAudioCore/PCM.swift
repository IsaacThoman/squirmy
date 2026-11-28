import AudioToolbox
import Foundation

/// The engine's sample format everywhere after decoding: 32-bit float, stereo, interleaved.
enum PCM {
  static let channels = 2

  /// The stream description of that format at `rate`.
  static func format(rate: Double) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription(
      mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 8, mFramesPerPacket: 1, mBytesPerFrame: 8, mChannelsPerFrame: 2, mBitsPerChannel: 32, mReserved: 0)
  }

  /// Float samples interleaved in `channels` channels, as decoders produce them, made stereo.
  /// Mono plays on both sides. More channels keep the first two, which are the front left
  /// and right in the layouts the server's transcodes use; files are mixed down by Apple's
  /// converter instead (`FileDecoder`), which knows their layout.
  static func stereo(_ samples: UnsafePointer<Float>, frames: Int, channels: Int) -> [Float] {
    if channels == 2 { return Array(UnsafeBufferPointer(start: samples, count: frames * 2)) }
    var out = [Float](repeating: 0, count: frames * 2)
    out.withUnsafeMutableBufferPointer { out in
      for frame in 0..<frames {
        let left = samples[frame * channels]
        out[frame * 2] = left
        out[frame * 2 + 1] = channels == 1 ? left : samples[frame * channels + 1]
      }
    }
    return out
  }
}

/// What can go wrong between a URL and a sample. `message` is what JavaScript shows, and
/// keeps the domain and code a URL error has, which the app's wording looks for.
struct EngineError: Error, CustomStringConvertible {
  let message: String
  var description: String { message }

  static let cancelled = EngineError(message: "Cancelled")

  static func http(_ status: Int) -> EngineError {
    EngineError(message: "The server answered HTTP \(status)")
  }

  static func status(_ status: OSStatus, _ what: String) -> EngineError {
    EngineError(message: "\(what) (\(fourCC(status)))")
  }

  static func wrapping(_ error: Error) -> EngineError {
    if let error = error as? EngineError { return error }
    let ns = error as NSError
    return EngineError(message: "\(ns.localizedDescription) (\(ns.domain) error \(ns.code).)")
  }
}

/// An OSStatus as its four characters when it is a four-character code, as Core Audio's are.
func fourCC(_ status: OSStatus) -> String {
  let n = UInt32(bitPattern: status)
  let bytes = [24, 16, 8, 0].map { UInt8((n >> $0) & 0xff) }
  if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }) { return "'\(String(decoding: bytes, as: UTF8.self))'" }
  return "\(status)"
}
