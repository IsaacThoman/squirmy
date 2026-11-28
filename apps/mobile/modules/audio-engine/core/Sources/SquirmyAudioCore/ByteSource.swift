import Foundation

/// What a source knows once the first response is in.
struct SourceInfo {
  /// Bytes in the whole stream; nil while a stream without a length (a transcode still being
  /// encoded) has not ended.
  var length: Int64?
  /// The server's `Content-Type`, or one guessed from a file's extension.
  var contentType: String?
  /// Where a stream asked for from a time (`start`) really begins, in frames of the track at
  /// the delivered rate (`X-Squirmy-Start-Frame`); nil for a stream from the beginning.
  var startFrame: Int64? = nil
}

/// The bytes of one stream, read by a decoder on its own queue. Reads block until their bytes
/// have arrived; `cancel` wakes them.
protocol ByteSource: AnyObject {
  /// Waits for the first response.
  func info() throws -> SourceInfo
  /// Waits for the length, which for a stream sent without one means waiting for its end.
  func length() throws -> Int64
  /// Reads `count` bytes at `offset`, waiting until they are there. Fewer only at the end,
  /// 0 past it.
  func read(at offset: Int64, count: Int, into buffer: UnsafeMutableRawPointer) throws -> Int
  /// Wakes every waiting read with `EngineError.cancelled`, as later reads fail too.
  func cancel()
  /// The whole stream is here (a file, or a download that finished).
  var isComplete: Bool { get }
  /// Where the bytes that are here from `offset` on end, without waiting: `offset` itself
  /// when that byte has not arrived.
  func available(from offset: Int64) -> Int64
}

/// A file on this device: a download, or a test fixture.
final class FileByteSource: ByteSource {
  private let descriptor: Int32
  private let size: Int64
  private let contentType: String?
  private var cancelled = false

  init(url: URL) throws {
    descriptor = open(url.path, O_RDONLY)
    guard descriptor >= 0 else { throw EngineError(message: "Couldn’t open \(url.lastPathComponent) (errno \(errno))") }
    var status = stat()
    fstat(descriptor, &status)
    size = Int64(status.st_size)
    contentType = mimeType(forExtension: url.pathExtension)
  }

  deinit { close(descriptor) }

  func info() throws -> SourceInfo { SourceInfo(length: size, contentType: contentType) }
  func length() throws -> Int64 { size }
  var isComplete: Bool { true }
  func available(from offset: Int64) -> Int64 { max(offset, size) }

  func read(at offset: Int64, count: Int, into buffer: UnsafeMutableRawPointer) throws -> Int {
    if cancelled { throw EngineError.cancelled }
    guard offset < size else { return 0 }
    let wanted = Int(min(Int64(count), size - offset))
    var done = 0
    while done < wanted {
      let n = pread(descriptor, buffer + done, wanted - done, off_t(offset) + off_t(done))
      if n <= 0 { throw EngineError(message: "Couldn’t read the file (errno \(errno))") }
      done += n
    }
    return done
  }

  func cancel() { cancelled = true }
}

/// Byte ranges as sorted, merged half-open intervals.
struct RangeSet {
  private(set) var ranges: [Range<Int64>] = []

  mutating func insert(_ range: Range<Int64>) {
    guard !range.isEmpty else { return }
    var merged = range
    var kept: [Range<Int64>] = []
    for existing in ranges {
      if existing.upperBound < merged.lowerBound || existing.lowerBound > merged.upperBound {
        kept.append(existing)
      } else {
        merged = min(existing.lowerBound, merged.lowerBound)..<max(existing.upperBound, merged.upperBound)
      }
    }
    kept.append(merged)
    ranges = kept.sorted { $0.lowerBound < $1.lowerBound }
  }

  func contains(_ range: Range<Int64>) -> Bool {
    range.isEmpty || ranges.contains { $0.lowerBound <= range.lowerBound && $0.upperBound >= range.upperBound }
  }

  /// Where the run of bytes that contains `offset` ends, or nil when `offset` is missing.
  func end(of offset: Int64) -> Int64? {
    ranges.first { $0.contains(offset) }?.upperBound
  }
}

/// The MIME type for a file's extension, for the decoders' format hint.
func mimeType(forExtension pathExtension: String) -> String? {
  switch pathExtension.lowercased() {
  case "flac": return "audio/flac"
  case "m4a", "mp4", "alac", "m4b": return "audio/mp4"
  case "mp3": return "audio/mpeg"
  case "aac", "adts": return "audio/aac"
  case "ogg", "opus", "oga": return "audio/ogg"
  case "wav", "wave": return "audio/wav"
  case "aif", "aiff", "aifc": return "audio/aiff"
  case "caf": return "audio/x-caf"
  default: return nil
  }
}
