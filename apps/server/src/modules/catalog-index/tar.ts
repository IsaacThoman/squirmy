const BLOCK = 512

/** One file in a tar archive. Read `body` before asking for the next entry, or it is skipped. */
export type TarEntry = { path: string; size: number; body: AsyncGenerator<Buffer> }

/** Buffers just enough of a byte stream to hand out exact-length reads. */
class ByteReader {
  private buffer: Buffer = Buffer.alloc(0)
  private readonly iterator: AsyncIterator<Uint8Array>

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]()
  }

  private async fill(): Promise<boolean> {
    const next = await this.iterator.next()
    if (next.done) return false
    const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength)
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk
    return true
  }

  /** Exactly `length` bytes, or null if the stream ends first. */
  async read(length: number): Promise<Buffer | null> {
    while (this.buffer.length < length) if (!(await this.fill())) return null
    const out = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return out
  }

  /** Up to `max` bytes, as soon as any are available. Throws if the stream has ended. */
  async chunk(max: number): Promise<Buffer> {
    if (this.buffer.length === 0 && !(await this.fill())) throw new Error('The archive ended in the middle of a file')
    const out = this.buffer.subarray(0, Math.min(max, this.buffer.length))
    this.buffer = this.buffer.subarray(out.length)
    return out
  }

  async skip(length: number) {
    for (let left = length; left > 0;) left -= (await this.chunk(left)).length
  }
}

const text = (block: Buffer, start: number, length: number) => {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

/** Octal, or GNU base-256 when the high bit is set (files of 8 GiB and more). */
function numeric(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length)
  if (field[0]! & 0x80) {
    let value = field[0]! & 0x7f
    for (let i = 1; i < field.length; i++) value = value * 256 + field[i]!
    return value
  }
  const digits = text(block, start, length).trim()
  return digits ? Number.parseInt(digits, 8) : 0
}

function paxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.toString('utf8', offset, space), 10)
    if (!(length > 0)) break
    const record = data.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1)
    offset += length
  }
  return records
}

async function readData(reader: ByteReader, size: number): Promise<Buffer> {
  const data = await reader.read(size)
  if (!data) throw new Error('The archive ended in the middle of a header')
  await reader.skip((BLOCK - (size % BLOCK)) % BLOCK)
  return Buffer.from(data)
}

/**
 * Reads a tar stream (ustar with PAX and GNU long-name extensions) entry by entry,
 * without buffering file contents. Only regular files are yielded.
 */
export async function* readTar(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source)
  const global: Record<string, string> = {}
  let local: Record<string, string> = {}
  let longName: string | undefined

  for (;;) {
    const header = await reader.read(BLOCK)
    if (!header || header.every((byte) => byte === 0)) return
    const declared = numeric(header, 124, 12)
    const type = String.fromCharCode(header[156]!)

    if (type === 'x' || type === 'g') {
      const records = paxRecords(await readData(reader, declared))
      if (type === 'g') Object.assign(global, records)
      else local = records
      continue
    }
    if (type === 'L') {
      longName = (await readData(reader, declared)).toString('utf8').replace(/\0+$/, '')
      continue
    }

    const pax = { ...global, ...local }
    const prefix = header.subarray(257, 263).toString('latin1') === 'ustar\0' ? text(header, 345, 155) : ''
    const path = pax.path ?? longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100))
    const size = pax.size ? Number(pax.size) : declared
    local = {}
    longName = undefined

    const padding = (BLOCK - (size % BLOCK)) % BLOCK
    if (type !== '0' && type !== '\0' && type !== '7') {
      await reader.skip(size + padding)
      continue
    }
    // The consumer may stop reading early; whatever it leaves is skipped before the next header.
    let left = size
    const body = (async function* () {
      while (left > 0) {
        const chunk = await reader.chunk(left)
        left -= chunk.length
        yield chunk
      }
    })()
    yield { path, size, body }
    await reader.skip(left + padding)
  }
}
