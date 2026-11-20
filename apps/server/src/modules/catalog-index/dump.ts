import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { PassThrough, pipeline, Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import zlib from 'node:zlib'
import { userAgent } from '../../lib/http.js'

/** Where MetaBrainz publishes the canonical data dumps, one folder per dump. */
const DUMP_INDEX_URL = 'https://data.metabrainz.org/pub/musicbrainz/canonical_data/'

const dumpName = /musicbrainz-canonical-dump-(\d{8})-(\d{6})/

/**
 * The URL of the newest `.tar.zst` listed in the dump index. Folder names carry the
 * dump time, so the newest is the greatest name.
 */
export async function findLatestDump(indexUrl = DUMP_INDEX_URL, signal?: AbortSignal): Promise<string> {
  const response = await fetch(indexUrl, { headers: { 'user-agent': userAgent() }, signal })
  if (!response.ok) throw new Error(`Could not list canonical dumps at ${indexUrl}: HTTP ${response.status}`)
  const names = [...(await response.text()).matchAll(/href="(musicbrainz-canonical-dump-\d{8}-\d{6})\/?"/g)].map((match) => match[1]!)
  const newest = names.sort().at(-1)
  if (!newest) throw new Error(`No canonical dumps are listed at ${indexUrl}`)
  return new URL(`${newest}/${newest}.tar.zst`, indexUrl).toString()
}

/** The dump time encoded in a dump's file or folder name, if it has one. */
export function dumpDateFromName(name: string): Date | null {
  const match = dumpName.exec(name)
  if (!match) return null
  const [, day, time] = match as unknown as [string, string, string]
  return new Date(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`)
}

export type OpenedSource = {
  stream: Readable
  /** Compressed size when known, for progress. */
  totalBytes: number | null
}

/**
 * Opens a dump by URL (http or https) or by local path, as a compressed byte stream.
 * This is a plain fetch rather than lib/http's `request`: a multi-gigabyte download
 * must not have a timeout or go through the response cache.
 */
export async function openSource(source: string, signal?: AbortSignal): Promise<OpenedSource> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { headers: { 'user-agent': userAgent() }, signal })
    if (!response.ok || !response.body) throw new Error(`Could not download ${source}: HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length'))
    return {
      stream: Readable.fromWeb(response.body as WebReadableStream<Uint8Array>, { signal }),
      totalBytes: length > 0 ? length : null,
    }
  }
  const info = await stat(source)
  return { stream: createReadStream(source, { signal, highWaterMark: 1 << 20 }), totalBytes: info.size }
}

/**
 * Decompresses a zstd stream with the zstd built into Node's zlib (Node 22.15 and
 * newer), or by piping through the `zstd` program when this Node lacks it.
 */
export function decompressZstd(input: Readable): Readable {
  // pipeline, unlike pipe, passes a read error on to the output.
  if (typeof zlib.createZstdDecompress === 'function') return pipeline(input, zlib.createZstdDecompress(), () => {})
  return spawnZstd(input)
}

/** The `zstd` binary fallback. Exported so tests can exercise it on any Node. */
export function spawnZstd(input: Readable): Readable {
  const child = spawn('zstd', ['-dc'], { stdio: ['pipe', 'pipe', 'pipe'] })
  // The output ends only once zstd has exited cleanly, so a corrupt archive is an error, not a short read.
  const output = new PassThrough()
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  child.stdout.pipe(output, { end: false })
  child.on('error', (error: NodeJS.ErrnoException) => {
    output.destroy(error.code === 'ENOENT'
      ? new Error('Reading the dump needs zstd: run Node 22.15 or newer, or install the zstd program')
      : error)
  })
  child.on('close', (code) => {
    if (code === 0) output.end()
    else output.destroy(new Error(`zstd failed (exit ${code}): ${stderr.trim()}`))
  })
  // A consumer that stops early must not leave the child waiting on a full pipe.
  output.on('close', () => {
    input.destroy()
    if (child.exitCode === null) child.kill()
  })
  input.on('error', (error) => output.destroy(error))
  child.stdin.on('error', () => {})
  input.pipe(child.stdin)
  return output
}
