import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, open, stat } from 'node:fs/promises'
import path from 'node:path'
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
  /** Compressed size when known, for progress. A resumed download may learn it only once it asks for the rest. */
  totalBytes: number | null
}

/**
 * Opens a dump by URL (http or https) or by local path, as a compressed byte stream.
 * This is a plain fetch rather than lib/http's `request`: a multi-gigabyte download
 * must not have a timeout or go through the response cache.
 *
 * With `cacheFile`, a download is also written to that file as it streams, and what an
 * earlier, interrupted run left there is read back first and only the rest is asked for
 * (an HTTP range request). The archive is a single zstd frame, so decoding always starts
 * at byte 0; the file spares the network, which on a slow link is most of an import.
 */
export async function openSource(source: string, signal?: AbortSignal, options: { cacheFile?: string; totalBytes?: number | null } = {}): Promise<OpenedSource> {
  if (/^https?:\/\//i.test(source)) {
    if (options.cacheFile) return openCachedDownload(source, options.cacheFile, options.totalBytes ?? null, signal)
    const response = await fetchDump(source, 0, signal)
    return { stream: Readable.fromWeb(response.body, { signal }), totalBytes: response.totalBytes }
  }
  const info = await stat(source)
  return { stream: createReadStream(source, { signal, highWaterMark: 1 << 20 }), totalBytes: info.size }
}

type DumpResponse = { body: WebReadableStream<Uint8Array>; totalBytes: number | null; status: number }

/** GETs a dump, from byte `from` on when it is not 0. */
async function fetchDump(source: string, from: number, signal?: AbortSignal): Promise<DumpResponse> {
  const headers: Record<string, string> = { 'user-agent': userAgent() }
  if (from > 0) headers.range = `bytes=${from}-`
  const response = await fetch(source, { headers, signal })
  if (!response.ok || !response.body) throw new Error(`Could not download ${source}: HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length'))
  const total = Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1])
  const totalBytes = total > 0 ? total : length > 0 ? length + (response.status === 206 ? from : 0) : null
  return { body: response.body as WebReadableStream<Uint8Array>, totalBytes, status: response.status }
}

async function openCachedDownload(source: string, file: string, knownTotal: number | null, signal?: AbortSignal): Promise<OpenedSource> {
  await mkdir(path.dirname(file), { recursive: true })
  const have = await stat(file).then((info) => info.size, () => 0)
  // Nothing cached: ask now, so the size is known for progress from the start. Otherwise the
  // request waits until the cached part has been read, which can take minutes: an idle
  // response opened now could be closed by the server in the meantime.
  const first = have === 0 ? await fetchDump(source, 0, signal) : null
  const opened: OpenedSource = { stream: Readable.from([]), totalBytes: first?.totalBytes ?? knownTotal }
  async function* bytes(): AsyncGenerator<Uint8Array> {
    if (have > 0) yield* createReadStream(file, { signal, highWaterMark: 1 << 20, end: have - 1 })
    if (opened.totalBytes !== null && have >= opened.totalBytes) return
    const response = first ?? await fetchDump(source, have, signal)
    opened.totalBytes ??= response.totalBytes
    // A server that ignores the range sends the whole file again: rewrite the copy and pass on only what is new.
    const partial = have > 0 && response.status === 206
    let skip = partial ? 0 : have
    const out = await open(file, partial ? 'a' : 'w')
    try {
      for await (const chunk of Readable.fromWeb(response.body, { signal })) {
        const data = chunk as Buffer
        await out.write(data)
        if (skip >= data.length) {
          skip -= data.length
          continue
        }
        yield skip > 0 ? data.subarray(skip) : data
        skip = 0
      }
    } finally {
      await out.close()
    }
  }
  opened.stream = Readable.from(bytes(), { objectMode: false })
  return opened
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
