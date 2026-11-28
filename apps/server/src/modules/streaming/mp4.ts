const headerSize = 8
const maxMoofSize = 1024 * 1024

type Box = { type: string; offset: number; end: number }

function* boxes(data: Buffer, start: number, end: number): Generator<Box> {
  for (let offset = start; offset < end;) {
    if (offset + headerSize > end) throw new Error('Incomplete MP4 box header')
    const size = data.readUInt32BE(offset)
    if (size < headerSize || offset + size > end) throw new Error('Invalid MP4 box size')
    yield { type: data.toString('ascii', offset + 4, offset + 8), offset: offset + headerSize, end: offset + size }
    offset += size
  }
}

/**
 * FFmpeg writes one audio traf and trun per moof. Sample durations are explicit when
 * they differ, or inherited from tfhd when all packets are the same size in time.
 */
function sampleDurations(moof: Buffer) {
  const traf = [...boxes(moof, headerSize, moof.length)].find(({ type }) => type === 'traf')
  if (!traf) throw new Error('Missing MP4 track fragment')
  const children = [...boxes(moof, traf.offset, traf.end)]
  const tfhd = children.find(({ type }) => type === 'tfhd')
  const trun = children.find(({ type }) => type === 'trun')
  if (!tfhd || !trun) throw new Error('Missing MP4 fragment header or run')
  const flags = moof.readUInt32BE(trun.offset)
  const count = moof.readUInt32BE(trun.offset + 4)
  if (!count) throw new Error('Empty MP4 fragment')
  if (flags & 0x100) {
    const first = trun.offset + 8 + (flags & 0x001 ? 4 : 0) + (flags & 0x004 ? 4 : 0)
    const stride = 4 + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0)
    if (first + count * stride > trun.end) throw new Error('Incomplete MP4 sample table')
    return { first, last: first + (count - 1) * stride, count }
  }

  const defaults = moof.readUInt32BE(tfhd.offset)
  const duration = tfhd.offset + 8 + (defaults & 0x001 ? 8 : 0) + (defaults & 0x002 ? 4 : 0)
  if (!(defaults & 0x008) || duration + 4 > tfhd.end) throw new Error('Missing MP4 default duration')
  // Changing a shared default would change the timeline of the preceding samples too.
  return { first: duration, last: count === 1 ? duration : null, count }
}

/**
 * AAC and Opus decoders output whole packets. MSE needs the coded tail duration to
 * apply the append window to that padding. Only the last packet of an encode is short;
 * setting each run's last duration to the full frame leaves earlier fragments untouched.
 * FFmpeg's 500 ms fragments bound the moof size, and the media payload passes through
 * without buffering. Box sizes, data offsets and the cached seek index stay intact.
 */
export async function* rewritePacketDurations(source: AsyncIterable<Buffer>, packetFrames: number | 'source'): AsyncGenerator<Buffer> {
  let fullDuration = packetFrames === 'source' ? undefined : packetFrames
  const header = Buffer.alloc(headerSize)
  let filled = 0
  let remaining = 0
  let moof: Buffer | undefined
  for await (const chunk of source) {
    for (let offset = 0; offset < chunk.length;) {
      if (remaining) {
        const size = Math.min(remaining, chunk.length - offset)
        if (moof) chunk.copy(moof, moof.length - remaining, offset, offset + size)
        else yield chunk.subarray(offset, offset + size)
        offset += size
        remaining -= size
        if (moof && !remaining) {
          const { first, last, count } = sampleDurations(moof)
          // A copied AAC stream can use a different frame size than the native encoder.
          if (fullDuration === undefined && count > 1) fullDuration = moof.readUInt32BE(first)
          if (last !== null) moof.writeUInt32BE(fullDuration ?? Math.max(1024, moof.readUInt32BE(last)), last)
          yield moof
          moof = undefined
        }
        continue
      }
      const size = Math.min(headerSize - filled, chunk.length - offset)
      chunk.copy(header, filled, offset, offset + size)
      filled += size
      offset += size
      if (filled !== headerSize) continue

      const boxSize = header.readUInt32BE(0)
      if (boxSize < headerSize) throw new Error('Invalid streamed MP4 box size')
      remaining = boxSize - headerSize
      filled = 0
      if (header.toString('ascii', 4, 8) === 'moof') {
        if (!remaining || boxSize > maxMoofSize) throw new Error('Invalid MP4 movie fragment size')
        moof = Buffer.allocUnsafe(boxSize)
        header.copy(moof)
      } else {
        yield Buffer.from(header)
      }
    }
  }
  if (remaining || filled) throw new Error('Incomplete streamed MP4 box')
}
