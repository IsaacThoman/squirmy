import XCTest
@testable import SquirmyAudioCore

/// Each delivery format's two halves, decoded separately, meet at the original's boundary.
final class DecoderTests: XCTestCase {
  private let split = Fixtures.splitFrame
  private var reference: [Float] { Fixtures.reference }

  func testLosslessHalvesAreTheOriginalToTheBit() throws {
    for (encoding, ext) in [("flac", "flac"), ("alac", "m4a")] {
      let pair = Fixtures.pair(encoding, ext)
      let a = decodeFile(pair.a)
      let b = decodeFile(pair.b)
      XCTAssertEqual(a.count / 2, split, encoding)
      XCTAssertEqual((a + b).count, reference.count, encoding)
      XCTAssertEqual(a + b, reference, "\(encoding): the halves back to back are not the original")
    }
  }

  func testLossyOriginalsMeetWithoutAGap() throws {
    for (encoding, ext) in [("aac", "m4a"), ("mp3", "mp3")] {
      let pair = Fixtures.pair(encoding, ext)
      let a = decodeFile(pair.a)
      let b = decodeFile(pair.b)
      XCTAssertEqual(a.count / 2, split, "\(encoding): the first half has the wrong length")
      XCTAssertEqual(boundaryGap(a: a, b: b, reference: reference, split: split), 0, "\(encoding) is not gapless")
    }
  }

  func testOggOpusMeetsWithinTheResamplersSample() throws {
    let pair = Fixtures.pair("opus", "opus")
    let a = decodeFile(pair.a)
    let b = decodeFile(pair.b)
    let reference48k = resampled(reference, to: 48_000)
    let split48k = Int((Double(split) * 48_000 / Fixtures.rate).rounded())
    XCTAssertLessThanOrEqual(abs(a.count / 2 - split48k), 1)
    XCTAssertLessThanOrEqual(abs(boundaryGap(a: a, b: b, reference: reference48k, split: split48k)), 1)
  }

  func testTodaysTranscodesKeepTheirEncodersGaps() throws {
    // ADTS and MP3 without a LAME tag carry no gapless information: these are the gaps the
    // server's `aac_256` and `mp3_320` have until it sends exact numbers.
    for (encoding, ext) in [("aac_256", "aac"), ("mp3_320", "mp3")] {
      let pair = Fixtures.pair(encoding, ext)
      let a = decodeFile(pair.a, kind: .stream)
      let b = decodeFile(pair.b, kind: .stream)
      let gap = boundaryGap(a: a, b: b, reference: reference, split: split)
      XCTAssertGreaterThan(gap, 500, encoding)
      XCTAssertLessThan(gap, 2500, encoding)
    }
  }

  func testAStreamTrimmedWithTheServersNumbersIsExact() throws {
    // ffmpeg's AAC encoder primes with 1,024 frames; the descriptor will carry that and the length.
    let pair = Fixtures.pair("aac_256", "aac")
    let a = decodeFile(pair.a, kind: .stream, gapless: Gapless(sampleRate: Fixtures.rate, primingFrames: 1024, frames: Int64(split)))
    let b = decodeFile(pair.b, kind: .stream, gapless: Gapless(sampleRate: Fixtures.rate, primingFrames: 1024, frames: Int64(reference.count / 2 - split)))
    XCTAssertEqual(a.count / 2, split)
    XCTAssertEqual(b.count / 2, reference.count / 2 - split)
    XCTAssertEqual(boundaryGap(a: a, b: b, reference: reference, split: split), 0)
  }

  func testAWrongLengthDoesNotCutASongShort() throws {
    let pair = Fixtures.pair("aac_256", "aac")
    let whole = decodeFile(pair.a, kind: .stream)
    let cut = decodeFile(pair.a, kind: .stream, gapless: Gapless(sampleRate: Fixtures.rate, primingFrames: 0, frames: 10_000))
    XCTAssertEqual(cut.count, whole.count)
  }

  func testSeeksLandOnTheSampleInFiles() throws {
    for (encoding, ext) in [("flac", "flac"), ("alac", "m4a"), ("aac", "m4a")] {
      let url = Fixtures.pair(encoding, ext).b
      let whole = decodeFile(url)
      let decoder = try FileDecoder(source: try FileByteSource(url: url))
      try decoder.seek(to: 30_000)
      let after = try decodeAll(decoder)
      XCTAssertEqual(after.count, whole.count - 60_000, encoding)
      XCTAssertLessThan(maxDifference(after[0...], whole[60_000...]), encoding == "aac" ? 0.002 : 1e-7, encoding)
    }
  }

  func testSeeksInStreamsLandNearTheTarget() throws {
    let url = Fixtures.pair("mp3_320", "mp3").b
    let whole = decodeFile(url, kind: .stream)
    let decoder = try StreamDecoder(source: try FileByteSource(url: url), gapless: nil)
    try decoder.seek(to: 30_000)
    let after = try decodeAll(decoder)
    // Constant bitrate, so the byte offset is exact; the preroll fills the bit reservoir.
    let lag = bestLag(channel(after, 0), channel(whole, 0), refStart: 30_000 + 4096, start: 4096, maxLag: 2000)
    XCTAssertLessThanOrEqual(abs(lag), 1)
  }

  func testMonoPlaysOnBothSides() throws {
    let mono: [Float] = [0.1, -0.2, 0.3]
    let stereo = mono.withUnsafeBufferPointer { PCM.stereo($0.baseAddress!, frames: 3, channels: 1) }
    XCTAssertEqual(stereo, [0.1, 0.1, -0.2, -0.2, 0.3, 0.3])
  }

  func testReadsTheOpusPreSkipFromTheOggHeader() throws {
    let data = try Data(contentsOf: Fixtures.pair("opus", "opus").a)
    XCTAssertEqual(StreamDecoder.opusPreSkip(Array(data)[...]), 312)
  }
}
