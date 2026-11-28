import AudioToolbox
import Foundation

/// A seek to a frame this stream does not have yet (past what has arrived of a transcode
/// still being sent) or at all (before where a stream asked for from a time begins).
/// `Pipeline` asks the server for the stream from that time instead.
struct SeekOutsideStream: Error {}

/**
 * Server transcodes, read in order as they arrive with no length needed, so a transcode still
 * being encoded plays, and decoded by `AudioConverter`. Fragmented MP4 (the fragmented
 * profiles) is read by `FragmentedMP4`, which also finds the fragment a seek lands in;
 * Apple's `AudioFileStream` reads only its format there, and parses today's ADTS, MP3 and
 * Ogg transcodes whole.
 *
 * It trims with the descriptor's `gapless` numbers when they come: `primingFrames` from the
 * start and everything after `frames`, the end only when what is left is less than one of
 * the codec's frames, so a wrong number cannot cut a song short. Without them it uses what
 * the container says (an MP4's packet table, an Ogg Opus header's pre-skip). Today's ADTS
 * AAC and MP3 transcodes say nothing, and keep their encoders' gaps.
 *
 * A stream asked for from a time (`X-Squirmy-Start-Frame`) is numbered from where it begins
 * in the track, after its own priming.
 */
final class StreamDecoder: AudioDecoder {
  private static let chunkBytes = 32 * 1024
  /// Packets decoded before a seek's target and dropped, so the decoder's overlap and an
  /// MP3's bit reservoir are filled when the target plays.
  private static let prerollPackets: Int64 = 3

  private let source: ByteSource
  private let gapless: Gapless?
  /// The fragments of a fragmented MP4 stream; nil for the formats Apple's parser reads whole.
  private var fragments: FragmentedMP4?
  /// The track frame this stream's first real sample is.
  let startFrame: Int64
  /// A seek outside what has arrived throws `SeekOutsideStream` instead of waiting for it.
  private let canRestart: Bool
  private var parser: AudioFileStreamID?
  private var converter: AudioConverterRef?
  private var format = AudioStreamBasicDescription()
  private var ready = false
  private var cookie: [UInt8] = []
  private var packetTable: AudioFilePacketTableInfo?
  private var dataOffset: Int64 = 0
  private var oggPreSkip: Int64?

  private var packets: [(data: Data, description: AudioStreamPacketDescription?)] = []
  private var nextPacket = 0
  /// The packet the converter reads now, which must stay put until it asks for the next.
  private var current = UnsafeMutableRawPointer.allocate(byteCount: 8192, alignment: 16)
  private var currentCapacity = 8192
  private let currentDescription = UnsafeMutablePointer<AudioStreamPacketDescription>.allocate(capacity: 1)
  private var readOffset: Int64 = 0
  private var discontinuity = false
  private var sourceEnded = false
  private var inputEnded = false
  private var error: Error?

  private var skip: Int64 = 0
  private var produced: Int64 = 0
  private var limit: Int64?
  private var held: [Float] = []
  private var finished = false
  private var output: [Float] = []

  /// `canRestart`: the server can send the stream from a time, so a seek past what has arrived
  /// need not wait for it.
  init(source: ByteSource, gapless: Gapless?, canRestart: Bool = false) throws {
    self.source = source
    self.gapless = gapless
    self.canRestart = canRestart
    let info = try source.info()
    startFrame = info.startFrame ?? 0
    let hint = audioFileType(contentType: info.contentType)
    if hint == kAudioFileM4AType || hint == 0, let fragments = try FragmentedMP4.open(source) {
      self.fragments = fragments
      try openParser(hint: kAudioFileM4AType)
      // Apple's parser reads the format and the codec's settings from the `moov`.
      try parseInit(upTo: fragments.initEnd)
      guard format.mFormatID != 0, format.mSampleRate > 0 else { throw EngineError(message: "This stream’s format can’t be decoded") }
      fragments.sampleRate = format.mSampleRate
      if let parser { AudioFileStreamClose(parser) }
      parser = nil
    } else {
      try openParser(hint: hint)
      while !ready {
        guard try feed() else { throw EngineError(message: "This stream’s format can’t be decoded") }
      }
    }
    try makeConverter()
    skip = max(0, primingFrames - decoderDelay)
    produced = startFrame
    limit = gapless?.frames ?? packetTable.flatMap { $0.mNumberValidFrames > 0 ? $0.mNumberValidFrames : nil }
  }

  deinit {
    if let converter { AudioConverterDispose(converter) }
    if let parser { AudioFileStreamClose(parser) }
    current.deallocate()
    currentDescription.deallocate()
  }

  var sampleRate: Double { format.mSampleRate }

  var estimatedFrames: Int64? {
    if let limit { return limit }
    guard let length = try? source.info().length, let parser else { return nil }
    var bytesPerPacket: Float64 = 0
    var size = UInt32(MemoryLayout<Float64>.size)
    guard AudioFileStreamGetProperty(parser, kAudioFileStreamProperty_AverageBytesPerPacket, &size, &bytesPerPacket) == noErr,
          bytesPerPacket > 0, format.mFramesPerPacket > 0 else { return nil }
    return Int64(Double(length - dataOffset) / bytesPerPacket * Double(format.mFramesPerPacket)) - primingFrames
  }

  private var primingFrames: Int64 {
    gapless?.primingFrames ?? packetTable.map { Int64($0.mPrimingFrames) } ?? oggPreSkip ?? 0
  }

  /// Frames Apple's decoder leaves out of its output after a start or a reset: its Opus
  /// decoder begins 2.5 ms into the stream (measured against ffmpeg on macOS 27 and the
  /// iOS 27 simulator; Apple's file reader takes the same off Ogg Opus's pre-skip), so that
  /// much less is dropped to reach a frame.
  private var decoderDelay: Int64 {
    format.mFormatID == kAudioFormatOpus ? Int64((0.0025 * format.mSampleRate).rounded()) : 0
  }

  /// The codec's frame: the format's, or (Opus says none) the longest packet seen.
  private var codecFrames: Int64 {
    format.mFramesPerPacket > 0 ? Int64(format.mFramesPerPacket) : fragments?.largestSampleFrames ?? 0
  }

  /// Decoded before a seek's target and dropped, so a lossy decoder has settled when the
  /// target plays: three of its frames, and at least the 80 ms Opus asks for.
  private var prerollFrames: Int64 {
    switch format.mFormatID {
    case kAudioFormatFLAC, kAudioFormatAppleLossless, kAudioFormatLinearPCM: return 0
    default: return max(3 * codecFrames, Int64(0.08 * format.mSampleRate))
    }
  }

  func read(maxFrames: Int) throws -> [Float] {
    var out: [Float] = []
    out.reserveCapacity(maxFrames * 2)
    while !finished, out.count < maxFrames * 2 {
      let decoded = try convert(maxFrames: maxFrames - out.count / 2)
      if decoded.isEmpty {
        // Less than a codec frame past the length: the encoder's padding.
        held.removeAll()
        finished = true
        break
      }
      take(decoded, into: &out)
    }
    return out
  }

  func seek(to frame: Int64) throws {
    if let fragments { return try seekFragments(to: frame, fragments) }
    let priming = primingFrames
    let target = max(0, frame) + priming
    let framesPerPacket = Int64(format.mFramesPerPacket)
    var landed = false
    if framesPerPacket > 0, let parser {
      let packet = max(0, target / framesPerPacket - Self.prerollPackets)
      var byteOffset: Int64 = 0
      var flags = AudioFileStreamSeekFlags(rawValue: 0)
      if AudioFileStreamSeek(parser, packet, &byteOffset, &flags) == noErr {
        reset(at: dataOffset + byteOffset)
        discontinuity = true
        skip = max(0, target - packet * framesPerPacket - decoderDelay)
        landed = true
      }
    }
    if !landed {
      // A container that cannot say where a packet is: decode from the start and drop
      // everything before the target.
      if let parser { AudioFileStreamClose(parser) }
      parser = nil
      ready = false
      reset(at: 0)
      try openParser(hint: audioFileType(contentType: try source.info().contentType))
      while !ready {
        guard try feed() else { throw EngineError(message: "This stream ended before it began") }
      }
      skip = max(0, target - decoderDelay)
    }
    produced = max(0, frame)
  }

  /// Goes on from the fragment a little before `frame`, when that part of the stream is here.
  private func seekFragments(to frame: Int64, _ fragments: FragmentedMP4) throws {
    if frame < startFrame { throw SeekOutsideStream() }
    let target = frame - startFrame + primingFrames
    try fragments.scan(through: target, waiting: !canRestart)
    if fragments.fragments.last.map({ $0.end <= target }) ?? true {
      guard fragments.ended else { throw SeekOutsideStream() }
      // Past the end: nothing more plays.
      fragments.rewind(toFragment: fragments.fragments.count)
      resetDecoding()
      skip = 0
      produced = frame
      return
    }
    let index = fragments.fragmentIndex(holding: max(0, target - prerollFrames)) ?? 0
    fragments.rewind(toFragment: index)
    resetDecoding()
    skip = max(0, target - fragments.fragments[index].start - decoderDelay)
    produced = frame
  }

  // MARK: - Parsing

  /// Gives Apple's parser a fragmented stream's `ftyp` and `moov`, for the format.
  private func parseInit(upTo end: Int64) throws {
    let count = Int(end)
    var bytes = [UInt8](repeating: 0, count: count)
    var done = 0
    while done < count {
      let n = try bytes.withUnsafeMutableBytes { try source.read(at: Int64(done), count: count - done, into: $0.baseAddress! + done) }
      guard n > 0 else { throw EngineError(message: "This stream ended before it began") }
      done += n
    }
    let status = bytes.withUnsafeBytes { AudioFileStreamParseBytes(parser!, UInt32(bytes.count), $0.baseAddress!, []) }
    if let error { throw error }
    guard status == noErr else { throw EngineError.status(status, "This stream couldn’t be parsed") }
  }

  private func openParser(hint: AudioFileTypeID) throws {
    let client = Unmanaged.passUnretained(self).toOpaque()
    let status = AudioFileStreamOpen(client, { client, stream, property, _ in
      Unmanaged<StreamDecoder>.fromOpaque(client).takeUnretainedValue().property(stream, property)
    }, { client, bytes, count, data, descriptions in
      Unmanaged<StreamDecoder>.fromOpaque(client).takeUnretainedValue().receive(bytes: bytes, count: count, data: data, descriptions: descriptions)
    }, hint, &parser)
    guard status == noErr else { throw EngineError.status(status, "This stream’s format can’t be decoded") }
  }

  private func reset(at offset: Int64) {
    readOffset = offset
    sourceEnded = false
    resetDecoding()
  }

  /// Forgets what was parsed and decoded, for packets from somewhere else in the stream.
  private func resetDecoding() {
    packets.removeAll()
    nextPacket = 0
    inputEnded = false
    finished = false
    held.removeAll()
    // A new converter rather than `AudioConverterReset`, which leaves Apple's Opus decoder
    // part way through what it had (its output after a seek came out 48 frames late).
    if let converter {
      AudioConverterDispose(converter)
      self.converter = nil
      try? makeConverter()
    }
  }

  /// Gives the parser the next bytes. False at the end of the stream.
  private func feed() throws -> Bool {
    if sourceEnded { return false }
    var chunk = [UInt8](repeating: 0, count: Self.chunkBytes)
    let count = try chunk.withUnsafeMutableBytes { try source.read(at: readOffset, count: Self.chunkBytes, into: $0.baseAddress!) }
    if count == 0 {
      sourceEnded = true
      return false
    }
    if readOffset == 0 { oggPreSkip = Self.opusPreSkip(chunk[0..<count]) }
    readOffset += Int64(count)
    let flags: AudioFileStreamParseFlags = discontinuity ? .discontinuity : []
    discontinuity = false
    let status = chunk.withUnsafeBytes { AudioFileStreamParseBytes(parser!, UInt32(count), $0.baseAddress!, flags) }
    if let error { throw error }
    guard status == noErr else { throw EngineError.status(status, "This stream couldn’t be parsed") }
    return true
  }

  private func property(_ stream: AudioFileStreamID, _ property: AudioFileStreamPropertyID) {
    switch property {
    case kAudioFileStreamProperty_DataFormat:
      var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
      AudioFileStreamGetProperty(stream, property, &size, &format)
    case kAudioFileStreamProperty_MagicCookieData:
      var size: UInt32 = 0
      var writable: DarwinBoolean = false
      if AudioFileStreamGetPropertyInfo(stream, property, &size, &writable) == noErr, size > 0 {
        cookie = [UInt8](repeating: 0, count: Int(size))
        AudioFileStreamGetProperty(stream, property, &size, &cookie)
      }
    case kAudioFileStreamProperty_DataOffset:
      var offset: Int64 = 0
      var size = UInt32(MemoryLayout<Int64>.size)
      if AudioFileStreamGetProperty(stream, property, &size, &offset) == noErr { dataOffset = offset }
    case kAudioFileStreamProperty_ReadyToProducePackets:
      var info = AudioFilePacketTableInfo()
      var size = UInt32(MemoryLayout<AudioFilePacketTableInfo>.size)
      if AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_PacketTableInfo, &size, &info) == noErr {
        packetTable = info
      }
      ready = true
    default:
      break
    }
  }

  private func receive(bytes: UInt32, count: UInt32, data: UnsafeRawPointer, descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
    if let descriptions {
      for index in 0..<Int(count) {
        let description = descriptions[index]
        packets.append((Data(bytes: data + Int(description.mStartOffset), count: Int(description.mDataByteSize)), description))
      }
    } else if format.mBytesPerPacket > 0 {
      // Constant-size packets (PCM): split the run so each packet goes in on its own.
      let size = Int(format.mBytesPerPacket)
      var offset = 0
      while offset + size <= Int(bytes) {
        packets.append((Data(bytes: data + offset, count: size), nil))
        offset += size
      }
    }
  }

  /// The pre-skip of an Ogg Opus stream, from its `OpusHead` packet on the first page.
  static func opusPreSkip(_ bytes: ArraySlice<UInt8>) -> Int64? {
    let magic = Array("OpusHead".utf8)
    let data = Array(bytes.prefix(512))
    guard data.count >= magic.count + 12 else { return nil }
    for start in 0...(data.count - magic.count - 12) where Array(data[start..<start + magic.count]) == magic {
      let at = start + magic.count + 2
      return Int64(data[at]) | Int64(data[at + 1]) << 8
    }
    return nil
  }

  // MARK: - Decoding

  private func makeConverter() throws {
    var source = format
    var destination = PCM.format(rate: format.mSampleRate)
    destination.mChannelsPerFrame = format.mChannelsPerFrame
    destination.mBytesPerFrame = 4 * format.mChannelsPerFrame
    destination.mBytesPerPacket = destination.mBytesPerFrame
    var converter: AudioConverterRef?
    let status = AudioConverterNew(&source, &destination, &converter)
    guard status == noErr, let converter else { throw EngineError.status(status, "This stream’s codec can’t be decoded") }
    if !cookie.isEmpty {
      AudioConverterSetProperty(converter, kAudioConverterDecompressionMagicCookie, UInt32(cookie.count), cookie)
    }
    self.converter = converter
  }

  /// Decoded frames, untrimmed, in the stream's channels. Empty once the converter is drained.
  private func convert(maxFrames: Int) throws -> [Float] {
    guard let converter else { return [] }
    let channels = Int(format.mChannelsPerFrame)
    if output.count < maxFrames * channels { output = [Float](repeating: 0, count: maxFrames * channels) }
    var frames = UInt32(maxFrames)
    let client = Unmanaged.passUnretained(self).toOpaque()
    let status = output.withUnsafeMutableBytes { raw -> OSStatus in
      var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(
        mNumberChannels: UInt32(channels), mDataByteSize: UInt32(maxFrames * channels * 4), mData: raw.baseAddress))
      return AudioConverterFillComplexBuffer(converter, { _, packetCount, data, description, client in
        Unmanaged<StreamDecoder>.fromOpaque(client!).takeUnretainedValue().supply(packetCount, data, description)
      }, client, &frames, &list, nil)
    }
    if let error { throw error }
    guard status == noErr || frames > 0 else { throw EngineError.status(status, "This stream couldn’t be decoded") }
    return output.withUnsafeBufferPointer { PCM.stereo($0.baseAddress!, frames: Int(frames), channels: channels) }
  }

  /// The converter's input: one packet at a time, parsing more bytes as needed. No packets
  /// and no error is the end of the stream, which makes the converter give its last frames.
  private func supply(_ packetCount: UnsafeMutablePointer<UInt32>, _ data: UnsafeMutablePointer<AudioBufferList>, _ description: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?) -> OSStatus {
    do {
      while nextPacket >= packets.count, !inputEnded {
        packets.removeAll(keepingCapacity: true)
        nextPacket = 0
        if let fragments {
          if let packet = try fragments.next() {
            packets.append((packet.data, AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.data.count))))
          } else {
            inputEnded = true
          }
        } else if try !feed() {
          inputEnded = true
        }
      }
    } catch {
      self.error = error
      packetCount.pointee = 0
      return kAudioFileUnspecifiedError
    }
    guard nextPacket < packets.count else {
      packetCount.pointee = 0
      return noErr
    }
    let packet = packets[nextPacket]
    nextPacket += 1
    if packet.data.count > currentCapacity {
      current.deallocate()
      currentCapacity = packet.data.count
      current = UnsafeMutableRawPointer.allocate(byteCount: currentCapacity, alignment: 16)
    }
    packet.data.withUnsafeBytes { current.copyMemory(from: $0.baseAddress!, byteCount: $0.count) }
    data.pointee.mNumberBuffers = 1
    data.pointee.mBuffers.mNumberChannels = format.mChannelsPerFrame
    data.pointee.mBuffers.mDataByteSize = UInt32(packet.data.count)
    data.pointee.mBuffers.mData = current
    if let packetDescription = packet.description {
      currentDescription.pointee = AudioStreamPacketDescription(mStartOffset: 0, mVariableFramesInPacket: packetDescription.mVariableFramesInPacket, mDataByteSize: packetDescription.mDataByteSize)
      description?.pointee = currentDescription
    }
    packetCount.pointee = 1
    return noErr
  }

  /// Drops the priming (and a seek's preroll), and holds back what goes past the track's
  /// length until the end shows whether it is padding.
  private func take(_ decoded: [Float], into out: inout [Float]) {
    var start = 0
    let frames = decoded.count / 2
    if skip > 0 {
      let dropped = Int(min(skip, Int64(frames)))
      skip -= Int64(dropped)
      start = dropped
    }
    guard start < frames else { return }
    var keep = frames - start
    if let limit {
      let room = Int(max(0, limit - produced))
      if keep > room {
        held += decoded[(start + room) * 2..<frames * 2]
        keep = room
        // More past the length than one codec frame: the length was wrong. Play it all.
        if held.count / 2 >= max(1, Int(codecFrames)) {
          self.limit = nil
          out += decoded[start * 2..<(start + keep) * 2]
          out += held
          produced += Int64(keep + held.count / 2)
          held.removeAll()
          return
        }
      }
    }
    out += decoded[start * 2..<(start + keep) * 2]
    produced += Int64(keep)
  }
}
