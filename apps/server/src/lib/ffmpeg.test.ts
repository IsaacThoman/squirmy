import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeTone, writeHostileInputs } from '../test/audio.js'
import { audioHash, runFfmpeg, runFfprobe } from './ffmpeg.js'

describe('ffmpeg helpers', () => {
  process.env.DATABASE_URL ??= 'postgres://unused/unused'
  const directories: string[] = []
  afterAll(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }) })

  it.each(['flac', 'mp3', 'm4a', 'ogg', 'opus'] as const)('keeps the %s audio hash across retagging', async (format) => {
    const root = await mkdtemp(path.join(tmpdir(), 'squirmy-hash-'))
    directories.push(root)
    const original = await makeTone(root, { path: `a.${format}`, durationSec: 2, tags: { title: 'Before', artist: 'Someone' } })
    const retagged = path.join(root, `b.${format}`)
    await runFfmpeg(['-y', '-i', original, '-map', '0:a', '-c', 'copy', '-metadata', 'title=After', '-metadata', 'album=New Album', retagged])
    const moved = path.join(root, `moved.${format}`)
    await copyFile(original, moved)
    const other = await makeTone(root, { path: `c.${format}`, durationSec: 2, frequency: 880 })

    const hash = await audioHash(original)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(await audioHash(moved)).toBe(hash)
    expect(await audioHash(retagged)).toBe(hash)
    expect(await audioHash(other)).not.toBe(hash)
  })

  it('probes a file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'squirmy-probe-'))
    directories.push(root)
    const file = await makeTone(root, { path: 'a.flac', durationSec: 1 })
    const probe = await runFfprobe(file) as { format: { format_name: string }; streams: { codec_name: string }[] }
    expect(probe.format.format_name).toBe('flac')
    expect(probe.streams[0]?.codec_name).toBe('flac')
  })
  it('refuses inputs that would make ffmpeg open other files or the network', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'squirmy-hostile-'))
    directories.push(root)
    await makeTone(root, { path: 'real.flac', durationSec: 1 })
    const requests: string[] = []
    const server = http.createServer((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const files = await writeHostileInputs(root, { target: 'real.flac', url: `http://127.0.0.1:${port}` })
      for (const file of Object.values(files)) await expect(audioHash(file)).rejects.toThrow()
      // The concat script plays real.flac and the SDP opens sockets; neither demuxer may run.
      await expect(runFfprobe(files.concat)).rejects.toThrow(/not on whitelist|Invalid/)
      await expect(runFfprobe(files.sdp)).rejects.toThrow(/not on whitelist|Invalid/)
      expect(requests).toEqual([])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
