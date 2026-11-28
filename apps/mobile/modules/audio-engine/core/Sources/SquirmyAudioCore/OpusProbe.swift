import Foundation

/**
 * What the engine tells the server it decodes (`codecs` on `/tracks/:id/playback`). Apple's
 * decoders have Opus on current systems, but it was not tested on the oldest the app runs on,
 * so Opus is listed only when two embedded samples decode here (`OpusProbeSamples.swift`):
 * one as the server's Opus transcodes come (fragmented MP4, through `StreamDecoder`) and one
 * as an Ogg Opus original does (through `FileDecoder`). Without it the server sends AAC.
 */
enum OpusProbe {
  /// What every system the engine runs on decodes.
  static let baseCodecs = ["flac", "alac", "aac", "mp3", "wav", "aiff"]

  /// Decided once per run.
  static let codecs: [String] = baseCodecs + (decodesOpus() ? ["opus"] : [])

  static func decodesOpus() -> Bool {
    decodes(fragmentedSample, contentType: "audio/mp4", stream: true) && decodes(oggSample, contentType: "audio/ogg", stream: false)
  }

  /// The sample decodes to its length, and is not silence.
  private static func decodes(_ base64: String, contentType: String, stream: Bool) -> Bool {
    guard let data = Data(base64Encoded: base64) else { return false }
    do {
      let source = MemoryByteSource(data: data, contentType: contentType)
      let decoder: AudioDecoder = stream
        ? try StreamDecoder(source: source, gapless: Gapless(sampleRate: 48_000, primingFrames: 312, frames: sampleFrames))
        : try FileDecoder(source: source)
      var samples: [Float] = []
      while true {
        let chunk = try decoder.read(maxFrames: 4096)
        if chunk.isEmpty { break }
        samples += chunk
      }
      return Int64(samples.count / 2) == sampleFrames && samples.contains { abs($0) > 1e-4 }
    } catch {
      return false
    }
  }
}

/// Bytes in memory, as a whole file.
final class MemoryByteSource: ByteSource {
  private let data: Data
  private let contentType: String?

  init(data: Data, contentType: String?) {
    self.data = data
    self.contentType = contentType
  }

  func info() throws -> SourceInfo { SourceInfo(length: Int64(data.count), contentType: contentType) }
  func length() throws -> Int64 { Int64(data.count) }
  var isComplete: Bool { true }
  func available(from offset: Int64) -> Int64 { max(offset, Int64(data.count)) }
  func cancel() {}

  func read(at offset: Int64, count: Int, into buffer: UnsafeMutableRawPointer) throws -> Int {
    guard offset < Int64(data.count) else { return 0 }
    let range = Int(offset)..<min(data.count, Int(offset) + count)
    data.copyBytes(to: buffer.assumingMemoryBound(to: UInt8.self), from: range)
    return range.count
  }
}
