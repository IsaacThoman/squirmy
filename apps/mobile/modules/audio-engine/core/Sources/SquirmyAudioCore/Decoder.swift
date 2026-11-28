import AudioToolbox
import Foundation

/// Turns one stream's bytes into stereo float PCM at the stream's own rate. Used on one
/// queue only; every call may block on the bytes.
protocol AudioDecoder: AnyObject {
  var sampleRate: Double { get }
  /// The track's length in frames when the container says so, else an estimate or nil.
  /// Only a hint: the end is where `read` returns nothing.
  var estimatedFrames: Int64? { get }
  /// Up to `maxFrames` frames, interleaved stereo. Empty at the end.
  func read(maxFrames: Int) throws -> [Float]
  /// The next `read` starts at `frame`.
  func seek(to frame: Int64) throws
}

/// Which decoder a delivery goes through. Each kind of delivery uses one, always, so a
/// format never alternates between two decoders that could disagree on it.
enum DecoderKind: String {
  /// Originals and downloads, through Apple's file reader, which applies the file's own
  /// gapless information.
  case file
  /// Server transcodes, live or cached: parsed as a stream, so one still being encoded
  /// plays, and trimmed with the numbers the server sends.
  case stream
}

/// The exact numbers of a delivered stream, from the playback descriptor.
struct Gapless {
  /// Of the delivered stream.
  var sampleRate: Double
  /// Frames to drop from the start of what the decoder produces.
  var primingFrames: Int64
  /// Real frames of the whole track.
  var frames: Int64
}

/// The container format for a MIME type or file extension, as a hint to Apple's parsers,
/// which otherwise guess from the bytes.
func audioFileType(contentType: String?) -> AudioFileTypeID {
  switch contentType?.lowercased().split(separator: ";").first.map({ $0.trimmingCharacters(in: .whitespaces) }) {
  case "audio/flac", "audio/x-flac": return kAudioFileFLACType
  case "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/alac": return kAudioFileM4AType
  case "audio/mpeg", "audio/mp3": return kAudioFileMP3Type
  case "audio/aac", "audio/aacp", "audio/x-aac": return kAudioFileAAC_ADTSType
  case "audio/wav", "audio/x-wav", "audio/wave": return kAudioFileWAVEType
  case "audio/aiff", "audio/x-aiff": return kAudioFileAIFFType
  case "audio/x-caf": return kAudioFileCAFType
  default: return 0
  }
}

/// Holds what the file reader's callbacks need, since they get one pointer.
private final class CallbackContext {
  let source: ByteSource
  var size: Int64 = 0
  var error: Error?
  init(source: ByteSource) { self.source = source }
}

/**
 * Originals and downloads: `AudioFileOpenWithCallbacks` over the bytes and
 * `ExtAudioFileWrapAudioFileID` for decoding. Apple applies the file's own gapless
 * information (MP4 edit lists and `iTunSMPB`, the LAME tag, Ogg Opus's pre-skip and end
 * trim, FLAC's exact length), so consecutive files meet without a gap. The end is wherever
 * reading stops, not the length the file claims: a FLAC written to a pipe says 0.
 */
final class FileDecoder: AudioDecoder {
  let sampleRate: Double
  let estimatedFrames: Int64?
  private let context: CallbackContext
  private var file: AudioFileID?
  private var ext: ExtAudioFileRef?
  private let channels: Int
  private var buffer: [Float] = []

  init(source: ByteSource) throws {
    let info = try source.info()
    context = CallbackContext(source: source)
    context.size = try source.length()
    let client = Unmanaged.passUnretained(context).toOpaque()
    var file: AudioFileID?
    var status = AudioFileOpenWithCallbacks(client, { client, position, count, buffer, actual in
      let context = Unmanaged<CallbackContext>.fromOpaque(client).takeUnretainedValue()
      do {
        actual.pointee = UInt32(try context.source.read(at: position, count: Int(count), into: buffer))
        return noErr
      } catch {
        context.error = error
        actual.pointee = 0
        return kAudioFileUnspecifiedError
      }
    }, nil, { client in
      Unmanaged<CallbackContext>.fromOpaque(client).takeUnretainedValue().size
    }, nil, audioFileType(contentType: info.contentType), &file)
    if let error = context.error { throw error }
    guard status == noErr, let file else { throw EngineError.status(status, "This file’s format can’t be decoded (open)") }
    self.file = file

    var ext: ExtAudioFileRef?
    status = ExtAudioFileWrapAudioFileID(file, false, &ext)
    guard status == noErr, let ext else {
      AudioFileClose(file)
      throw EngineError.status(status, "This file’s format can’t be decoded (wrap)")
    }
    self.ext = ext

    var fileFormat = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    ExtAudioFileGetProperty(ext, kExtAudioFileProperty_FileDataFormat, &size, &fileFormat)
    sampleRate = fileFormat.mSampleRate
    let fileChannels = Int(fileFormat.mChannelsPerFrame)
    // Mono and stereo are read as they are; Apple's converter mixes more channels down,
    // since it knows the file's layout.
    channels = fileChannels == 1 ? 1 : 2
    var clientFormat = PCM.format(rate: sampleRate)
    clientFormat.mChannelsPerFrame = UInt32(channels)
    clientFormat.mBytesPerFrame = UInt32(4 * channels)
    clientFormat.mBytesPerPacket = clientFormat.mBytesPerFrame
    if fileChannels > 2 {
      var layout = AudioChannelLayout()
      layout.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
      ExtAudioFileSetProperty(ext, kExtAudioFileProperty_ClientChannelLayout, UInt32(MemoryLayout<AudioChannelLayout>.size), &layout)
    }
    status = ExtAudioFileSetProperty(ext, kExtAudioFileProperty_ClientDataFormat, UInt32(MemoryLayout<AudioStreamBasicDescription>.size), &clientFormat)
    guard status == noErr else {
      ExtAudioFileDispose(ext)
      AudioFileClose(file)
      throw EngineError.status(status, "This file’s format can’t be decoded")
    }
    var frames: Int64 = 0
    size = UInt32(MemoryLayout<Int64>.size)
    ExtAudioFileGetProperty(ext, kExtAudioFileProperty_FileLengthFrames, &size, &frames)
    estimatedFrames = frames > 0 ? frames : nil
  }

  deinit {
    if let ext { ExtAudioFileDispose(ext) }
    if let file { AudioFileClose(file) }
  }

  func read(maxFrames: Int) throws -> [Float] {
    guard let ext else { return [] }
    if buffer.count < maxFrames * channels { buffer = [Float](repeating: 0, count: maxFrames * channels) }
    var frames = UInt32(maxFrames)
    let status = buffer.withUnsafeMutableBytes { raw -> OSStatus in
      var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
        mNumberChannels: UInt32(channels), mDataByteSize: UInt32(maxFrames * channels * 4), mData: raw.baseAddress))
      return ExtAudioFileRead(ext, &frames, &list)
    }
    if let error = context.error { throw error }
    // Some readers report an error at the very end; what was read still counts.
    guard status == noErr || frames > 0 else {
      if status == kAudioFileEndOfFileError { return [] }
      throw EngineError.status(status, "This file couldn’t be decoded")
    }
    return buffer.withUnsafeBufferPointer { PCM.stereo($0.baseAddress!, frames: Int(frames), channels: channels) }
  }

  func seek(to frame: Int64) throws {
    guard let ext else { return }
    let status = ExtAudioFileSeek(ext, frame)
    if let error = context.error { throw error }
    guard status == noErr else { throw EngineError.status(status, "Couldn’t seek in this file") }
  }
}
