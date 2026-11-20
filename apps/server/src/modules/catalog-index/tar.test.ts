import { describe, expect, it } from 'vitest'
import { tarEnd, tarFile } from './fixtures.js'
import { readTar } from './tar.js'

async function* chunked(data: Buffer, size: number) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
}

describe('readTar', () => {
  const long = `${'nested/'.repeat(20)}file.csv`
  const archive = Buffer.concat([
    tarFile('dump/TIMESTAMP', Buffer.from('2026-11-17 08:00:03')),
    tarFile(long, Buffer.from('x'.repeat(1500))),
    tarFile('dump/empty', Buffer.alloc(0)),
    tarEnd(),
  ])

  it('reads PAX paths and file bodies across any chunking', async () => {
    for (const size of [1, 100, 512, 4096]) {
      const files: [string, string][] = []
      for await (const entry of readTar(chunked(archive, size))) {
        const parts: Buffer[] = []
        for await (const chunk of entry.body) parts.push(chunk)
        files.push([entry.path, Buffer.concat(parts).toString()])
      }
      expect(files).toEqual([['dump/TIMESTAMP', '2026-11-17 08:00:03'], [long, 'x'.repeat(1500)], ['dump/empty', '']])
    }
  })

  it('skips the unread part of a body', async () => {
    const paths: string[] = []
    for await (const entry of readTar(chunked(archive, 300))) {
      paths.push(entry.path)
      for await (const chunk of entry.body) {
        void chunk
        break
      }
    }
    expect(paths).toEqual(['dump/TIMESTAMP', long, 'dump/empty'])
  })

  it('fails on a truncated archive', async () => {
    const truncated = archive.subarray(0, 2048 + 2048 + 300)
    await expect((async () => {
      for await (const entry of readTar(chunked(truncated, 512))) for await (const chunk of entry.body) void chunk
    })()).rejects.toThrow(/ended in the middle/)
  })
})
