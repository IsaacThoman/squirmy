import { readFile, writeFile } from 'node:fs/promises'
import { crc32, deflateRawSync } from 'node:zlib'

/**
 * Test helper: writes zip archives byte by byte, so tests can make the hostile ones no
 * zip tool would (`..` paths, symbolic links, sizes that lie).
 */
export type ZipEntrySpec = {
  name: string
  /** File contents, or the path of a file to read them from. */
  data?: Buffer | string
  /** Makes the entry a symbolic link pointing here. */
  symlink?: string
  /** The uncompressed size the archive claims, when it should lie. */
  declaredSize?: number
}

export async function writeZip(file: string, entries: ZipEntrySpec[]): Promise<string> {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const raw = entry.symlink !== undefined ? Buffer.from(entry.symlink)
      : typeof entry.data === 'string' ? await readFile(entry.data) : entry.data ?? Buffer.alloc(0)
    const compressed = deflateRawSync(raw)
    const size = entry.declaredSize ?? raw.length
    const mode = entry.symlink !== undefined ? 0o120777 : entry.name.endsWith('/') ? 0o040755 : 0o100644
    const fields = (header: Buffer, at: number) => {
      header.writeUInt16LE(0x0800, at) // UTF-8 names
      header.writeUInt16LE(8, at + 2) // deflate
      header.writeUInt32LE(0, at + 4) // time and date
      header.writeUInt32LE(crc32(raw), at + 8)
      header.writeUInt32LE(compressed.length, at + 12)
      header.writeUInt32LE(size, at + 16)
      header.writeUInt16LE(name.length, at + 20)
    }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    fields(local, 6)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made by Unix, so the mode below counts
    central.writeUInt16LE(20, 6)
    fields(central, 8)
    central.writeUInt32LE((mode << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, compressed)
    centrals.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  await writeFile(file, Buffer.concat([...locals, directory, end]))
  return file
}
