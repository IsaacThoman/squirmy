import Foundation

/**
 * The packets of a fragmented MP4 stream, as the server's fragmented profiles write it with
 * ffmpeg: `ftyp` and `moov` (with `mvex`), then `moof` and `mdat` pairs, one audio track,
 * each `trun` listing its samples' sizes and durations. Apple's stream parser reads such a
 * stream in order but cannot start again at a fragment after a seek, so the packets come
 * from here and Apple's parser only reads the format from the `moov`.
 *
 * Fragments are indexed as their `moof` boxes are read: by `next`, which waits for the bytes
 * as decoding does, or by `scan`, which reads only what has arrived, so a seek can tell
 * whether its target is here yet. Times are in the stream's frames, priming included.
 */
final class FragmentedMP4 {
  struct Sample {
    let offset: Int64
    let size: Int
    let frames: Int64
  }

  struct Fragment {
    /// Where its `moof` starts.
    let offset: Int64
    /// Its first frame in the stream.
    let start: Int64
    let frames: Int64
    let samples: [Sample]
    var end: Int64 { start + frames }
  }

  /// A packet and its frames.
  typealias Packet = (data: Data, frames: Int64)

  /// Where the first fragment begins: the bytes before it are `ftyp` and `moov`.
  let initEnd: Int64
  /// The ticks per second of the track's clock (`mdhd`), and the audio's frames per second,
  /// which `StreamDecoder` sets from the format before the first fragment is read.
  private let timescale: Int64
  var sampleRate: Double
  private let defaultDuration: UInt32
  private let defaultSize: UInt32
  private let source: ByteSource

  private(set) var fragments: [Fragment] = []
  /// The next top-level box not read yet.
  private var scanned: Int64
  /// The stream ended after the last fragment read.
  private(set) var ended = false
  /// The longest sample seen, in frames: the codec's frame when the format does not say.
  private(set) var largestSampleFrames: Int64 = 0

  /// Where decoding is: the fragment in `fragments`, and the sample in it.
  private var fragment = 0
  private var sample = 0

  /// Reads the init segment. Nil when the stream is not a fragmented MP4 (no `moov` with `mvex`).
  static func open(_ source: ByteSource, sampleRate: Double? = nil) throws -> FragmentedMP4? {
    var offset: Int64 = 0
    var moov: (body: Int64, end: Int64)?
    while moov == nil {
      guard let box = try readHeader(source, at: offset, waiting: true) else { return nil }
      guard let end = box.end else { return nil }
      switch box.type {
      case "ftyp", "free", "skip", "styp": offset = end
      case "moov": moov = (box.body, end)
      default: return nil
      }
    }
    guard let moov else { return nil }
    let bytes = try read(source, moov.body, Int(moov.end - moov.body))
    let tree = MP4Tree(bytes)
    guard let mvex = tree.child(of: 0..<bytes.count, "mvex"), let trex = tree.child(of: mvex, "trex"),
          let trak = tree.child(of: 0..<bytes.count, "trak"), let mdia = tree.child(of: trak, "mdia"),
          let mdhd = tree.child(of: mdia, "mdhd") else { return nil }
    // mdhd: version, then (v1) 8+8 or (v0) 4+4 bytes of times, then the timescale.
    let version = tree.byte(mdhd.lowerBound)
    let timescale = Int64(tree.u32(mdhd.lowerBound + (version == 1 ? 20 : 12)))
    // trex: version and flags, track id, description index, then the defaults.
    let defaultDuration = tree.u32(trex.lowerBound + 12)
    let defaultSize = tree.u32(trex.lowerBound + 16)
    guard timescale > 0 else { return nil }
    return FragmentedMP4(source: source, initEnd: moov.end, timescale: timescale, sampleRate: sampleRate ?? Double(timescale),
                         defaultDuration: defaultDuration, defaultSize: defaultSize)
  }

  private init(source: ByteSource, initEnd: Int64, timescale: Int64, sampleRate: Double, defaultDuration: UInt32, defaultSize: UInt32) {
    self.source = source
    self.initEnd = initEnd
    self.timescale = timescale
    self.sampleRate = sampleRate
    self.defaultDuration = defaultDuration
    self.defaultSize = defaultSize
    scanned = initEnd
  }

  /// The next packet in order, waiting for its bytes. Nil at the end of the stream.
  func next() throws -> Packet? {
    while fragment >= fragments.count || sample >= fragments[fragment].samples.count {
      if fragment < fragments.count { fragment += 1; sample = 0; continue }
      // Past what is indexed: read the next fragment.
      guard try readFragment(waiting: true) else { return nil }
    }
    let item = fragments[fragment].samples[sample]
    sample += 1
    return (try Self.read(source, item.offset, item.size), item.frames)
  }

  /// Indexes fragments until one reaches past `frame`, or the stream ends. Without `waiting`
  /// only those whose `moof` has arrived.
  func scan(through frame: Int64, waiting: Bool = false) throws {
    while !ended, (fragments.last?.end ?? 0) <= frame {
      guard try readFragment(waiting: waiting) else { return }
    }
  }

  /// The indexed fragment that holds `frame`, or the last one before it.
  func fragmentIndex(holding frame: Int64) -> Int? {
    guard let first = fragments.first, frame >= first.start else { return fragments.isEmpty ? nil : 0 }
    var low = 0
    var high = fragments.count - 1
    while low < high {
      let middle = (low + high + 1) / 2
      if fragments[middle].start <= frame { low = middle } else { high = middle - 1 }
    }
    return low
  }

  /// Decoding goes on from fragment `index`'s first packet.
  func rewind(toFragment index: Int) {
    fragment = index
    sample = 0
  }

  // MARK: - Reading boxes

  /// Reads the next top-level boxes up to and including a fragment's `moof`. False when the
  /// stream has ended, or (not waiting) when the next box has not arrived.
  private func readFragment(waiting: Bool) throws -> Bool {
    while true {
      guard waiting || source.available(from: scanned) >= scanned + 16 || source.isComplete else { return false }
      guard let box = try Self.readHeader(source, at: scanned, waiting: waiting) else {
        // Nothing more: the stream ended on a box boundary.
        if waiting || source.isComplete || (try? source.info().length).map({ $0 <= scanned }) == true { ended = true }
        return false
      }
      guard let end = box.end else { throw EngineError(message: "This stream has a box with no length") }
      if box.type != "moof" {
        scanned = end
        continue
      }
      guard end - box.offset <= 1 << 20 else { throw EngineError(message: "This stream has a fragment header too big to read") }
      if !waiting && source.available(from: box.offset) < end && !source.isComplete { return false }
      let bytes = try Self.read(source, box.body, Int(end - box.body))
      fragments.append(try parseFragment(MP4Tree(bytes), moof: box.offset))
      scanned = end
      return true
    }
  }

  /// One `moof`: its `tfdt` for where it starts, and its `trun` for its samples.
  private func parseFragment(_ tree: MP4Tree, moof: Int64) throws -> Fragment {
    let all = 0..<tree.count
    guard let traf = tree.child(of: all, "traf"), let tfhd = tree.child(of: traf, "tfhd"), let trun = tree.child(of: traf, "trun") else {
      throw EngineError(message: "This stream has a fragment with no track")
    }
    // tfhd: flags, track id, then the optional fields its flags name, in order.
    let tfhdFlags = tree.u32(tfhd.lowerBound) & 0xFFFFFF
    var at = tfhd.lowerBound + 8
    var base = moof
    if tfhdFlags & 0x01 != 0 { base = Int64(tree.u64(at)); at += 8 }
    if tfhdFlags & 0x02 != 0 { at += 4 }
    var duration = defaultDuration
    var size = defaultSize
    if tfhdFlags & 0x08 != 0 { duration = tree.u32(at); at += 4 }
    if tfhdFlags & 0x10 != 0 { size = tree.u32(at); at += 4 }

    var decodeTime: Int64 = fragments.last.map { $0.end * timescale / Int64(sampleRate) } ?? 0
    if let tfdt = tree.child(of: traf, "tfdt") {
      decodeTime = tree.byte(tfdt.lowerBound) == 1 ? Int64(tree.u64(tfdt.lowerBound + 4)) : Int64(tree.u32(tfdt.lowerBound + 4))
    }

    let flags = tree.u32(trun.lowerBound) & 0xFFFFFF
    let count = Int(tree.u32(trun.lowerBound + 4))
    at = trun.lowerBound + 8
    var data = base
    if flags & 0x001 != 0 { data = base + Int64(Int32(bitPattern: tree.u32(at))); at += 4 }
    if flags & 0x004 != 0 { at += 4 }
    let stride = [0x100, 0x200, 0x400, 0x800].filter { flags & UInt32($0) != 0 }.count * 4
    guard at + count * stride <= trun.upperBound else { throw EngineError(message: "This stream has a fragment cut short") }
    var samples: [Sample] = []
    samples.reserveCapacity(count)
    var time: Int64 = 0
    for _ in 0..<count {
      var sampleDuration = duration
      var sampleSize = size
      var field = at
      if flags & 0x100 != 0 { sampleDuration = tree.u32(field); field += 4 }
      if flags & 0x200 != 0 { sampleSize = tree.u32(field); field += 4 }
      at += stride
      let frames = frames(Int64(sampleDuration))
      samples.append(Sample(offset: data, size: Int(sampleSize), frames: frames))
      largestSampleFrames = max(largestSampleFrames, frames)
      data += Int64(sampleSize)
      time += Int64(sampleDuration)
    }
    return Fragment(offset: moof, start: frames(decodeTime), frames: frames(time), samples: samples)
  }

  private func frames(_ time: Int64) -> Int64 {
    timescale == Int64(sampleRate) ? time : Int64((Double(time) * sampleRate / Double(timescale)).rounded())
  }

  /// A top-level box's header at `offset`, or nil when the stream ends there (or, not
  /// waiting, when its header has not arrived).
  private static func readHeader(_ source: ByteSource, at offset: Int64, waiting: Bool) throws -> (type: String, offset: Int64, body: Int64, end: Int64?)? {
    if !waiting, source.available(from: offset) < offset + 8, !source.isComplete { return nil }
    let head = try read(source, offset, 8, exact: false)
    guard head.count == 8 else { return nil }
    let size = head.prefix(4).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
    let type = String(decoding: head.suffix(4), as: UTF8.self)
    if size == 1 {
      let large = try read(source, offset + 8, 8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
      return (type, offset, offset + 16, offset + Int64(large))
    }
    if size == 0 { return (type, offset, offset + 8, nil) }
    guard size >= 8 else { throw EngineError(message: "This stream has a broken box") }
    return (type, offset, offset + 8, offset + Int64(size))
  }

  /// `count` bytes at `offset`, waiting for them. Fewer only with `exact: false`, at the end.
  private static func read(_ source: ByteSource, _ offset: Int64, _ count: Int, exact: Bool = true) throws -> Data {
    var data = Data(count: count)
    var done = 0
    while done < count {
      let n = try data.withUnsafeMutableBytes { try source.read(at: offset + Int64(done), count: count - done, into: $0.baseAddress! + done) }
      if n == 0 { break }
      done += n
    }
    if done < count {
      if exact { throw EngineError(message: "This stream ended in the middle of a box") }
      data.count = done
    }
    return data
  }
}

/// Boxes inside a box's body, read from memory.
private struct MP4Tree {
  let bytes: [UInt8]
  init(_ data: Data) { bytes = [UInt8](data) }
  var count: Int { bytes.count }

  func byte(_ at: Int) -> UInt8 { at < bytes.count ? bytes[at] : 0 }
  func u32(_ at: Int) -> UInt32 {
    guard at + 4 <= bytes.count else { return 0 }
    return bytes[at..<at + 4].reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
  }
  func u64(_ at: Int) -> UInt64 { UInt64(u32(at)) << 32 | UInt64(u32(at + 4)) }

  /// The body of the first box of `type` directly inside `range`.
  func child(of range: Range<Int>, _ type: String) -> Range<Int>? {
    let wanted = Array(type.utf8)
    var at = range.lowerBound
    while at + 8 <= range.upperBound {
      let size = Int(u32(at))
      guard size >= 8, at + size <= range.upperBound else { return nil }
      if Array(bytes[at + 4..<at + 8]) == wanted { return at + 8..<at + size }
      at += size
    }
    return nil
  }
}
