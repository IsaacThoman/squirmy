import AVFoundation

/**
 * Converts one item's PCM to the engine's rate, at mastering quality, so the system does not
 * resample again and everything after it runs at one rate. Each item has its own, so no
 * filter state carries from one track into the next. Output frame 0 is input frame 0 (the
 * converter's default priming assumes silence before the start), and `finish` gives the
 * filter's tail, so a track keeps its exact length at the new rate.
 */
final class Resampler {
  private let converter: AVAudioConverter
  private let input: AVAudioFormat
  private let output: AVAudioFormat
  private let ratio: Double

  init?(from inputRate: Double, to outputRate: Double) {
    guard inputRate != outputRate,
          let input = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: 2, interleaved: true),
          let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: outputRate, channels: 2, interleaved: true),
          let converter = AVAudioConverter(from: input, to: output) else { return nil }
    converter.sampleRateConverterQuality = AVAudioQuality.max.rawValue
    converter.sampleRateConverterAlgorithm = AVSampleRateConverterAlgorithm_Mastering
    self.converter = converter
    self.input = input
    self.output = output
    ratio = outputRate / inputRate
  }

  func process(_ samples: [Float]) -> [Float] {
    let frames = samples.count / 2
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: input, frameCapacity: AVAudioFrameCount(frames)) else { return [] }
    buffer.frameLength = AVAudioFrameCount(frames)
    samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
    return convert(buffer)
  }

  /// The rest, at the end of the item.
  func finish() -> [Float] {
    convert(nil)
  }

  /// For a seek: forgets what came before.
  func reset() {
    converter.reset()
  }

  private func convert(_ buffer: AVAudioPCMBuffer?) -> [Float] {
    var out: [Float] = []
    var supplied = false
    let capacity = AVAudioFrameCount(Double(buffer?.frameLength ?? 0) * ratio) + 1024
    while true {
      guard let chunk = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { return out }
      var failure: NSError?
      let status = converter.convert(to: chunk, error: &failure) { _, inputStatus in
        guard let buffer else {
          inputStatus.pointee = .endOfStream
          return nil
        }
        if supplied {
          inputStatus.pointee = .noDataNow
          return nil
        }
        supplied = true
        inputStatus.pointee = .haveData
        return buffer
      }
      if chunk.frameLength > 0 {
        out += UnsafeBufferPointer(start: chunk.floatChannelData![0], count: Int(chunk.frameLength) * 2)
      }
      // A full chunk may have more behind it; anything else means the input is used up.
      if status != .haveData || chunk.frameLength < capacity { return out }
    }
  }
}
