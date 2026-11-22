import { spawn, type ChildProcess } from 'node:child_process'
import { getConfig } from '../../config.js'
import { audioInput, runFfprobe } from '../../lib/ffmpeg.js'
import { cachedFetch, ProviderError } from '../../lib/http.js'
import { getServerSecret, getServerSettings } from '../../lib/settings.js'

/** A Chromaprint fingerprint as fpcalc prints it, with the duration it covers. */
export type Fingerprint = { fingerprint: string; durationSec: number }

/** A MusicBrainz recording AcoustID links to the fingerprint. `score` is 0–1. */
export type AcoustIdMatch = {
  recordingMbid: string
  score: number
  /** The AcoustID track the recording was found through. */
  acoustId: string
  title: string | null
  artistName: string | null
  durationMs: number | null
}

type RawResponse = {
  status: 'ok' | 'error'
  error?: { code: number; message: string }
  results?: {
    id: string
    score: number
    recordings?: { id: string; title?: string; duration?: number; artists?: { name: string; joinphrase?: string }[] }[]
  }[]
}

const provider = 'acoustid'
const ttl = 30 * 86400

/** fpcalc's default: AcoustID fingerprints cover the first two minutes. */
const FINGERPRINT_SECONDS = 120

type Probe = { format?: { duration?: string }; streams?: { codec_type?: string; sample_rate?: string; channels?: number }[] }

/**
 * Resolves once a child exits with 0, with its stdout unless that is piped elsewhere;
 * rejects with its stderr otherwise.
 */
function finished(child: ChildProcess, name: string, { readStdout = true } = {}): Promise<string> {
  let stdout = ''
  let stderr = ''
  if (readStdout) {
    child.stdout?.setEncoding('utf8').on('data', (text: string) => {
      stdout += text
    })
  }
  child.stderr?.setEncoding('utf8').on('data', (text: string) => {
    stderr = (stderr + text).slice(-2000)
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${name} exited with ${code ?? 'a signal'}: ${stderr.trim()}`)))
  })
}

/**
 * Fingerprints an audio file with fpcalc (FPCALC_PATH). Null when fpcalc is not
 * installed; throws when the file cannot be decoded.
 *
 * fpcalc cannot be told which demuxers it may open a file with, so it never opens the
 * file: ffmpeg decodes it under the input guard and fpcalc reads the samples from a pipe,
 * which gives the fingerprint fpcalc computes from the file itself. A pipe carries no
 * duration, so that comes from the (guarded) probe.
 */
export async function fingerprint(filePath: string): Promise<Fingerprint | null> {
  const probe = await runFfprobe(filePath, 'format=duration:stream=codec_type,sample_rate,channels') as Probe
  const stream = probe.streams?.find((candidate) => candidate.codec_type === 'audio')
  const rate = Number(stream?.sample_rate)
  const durationSec = Number(probe.format?.duration)
  if (!stream?.channels || !(rate > 0) || !Number.isFinite(durationSec)) throw new Error(`No audio to fingerprint in ${filePath}`)

  const config = getConfig()
  const decoder = spawn(config.FFMPEG_PATH, [
    '-v', 'error', '-nostdin', ...audioInput(filePath),
    '-map', '0:a:0', '-t', String(FINGERPRINT_SECONDS), '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  const calculator = spawn(config.FPCALC_PATH, [
    '-json', '-format', 's16le', '-rate', String(rate), '-channels', String(stream.channels), '-length', String(FINGERPRINT_SECONDS), '-',
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  // A calculator that is missing or done early closes the pipe; the decoder's exit reports it.
  calculator.stdin!.on('error', () => {})
  decoder.stdout!.pipe(calculator.stdin!)
  const decoded = finished(decoder, 'ffmpeg', { readStdout: false })
  decoded.catch(() => {})
  try {
    let stdout: string
    try {
      stdout = await finished(calculator, 'fpcalc')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    // fpcalc also prints a fingerprint of whatever arrived before a decoder failed.
    await decoded
    const parsed = JSON.parse(stdout) as { fingerprint: string }
    return { fingerprint: parsed.fingerprint, durationSec: Math.round(durationSec) }
  } finally {
    if (decoder.exitCode === null) decoder.kill('SIGKILL')
    if (calculator.exitCode === null) calculator.kill('SIGKILL')
  }
}

/**
 * Recordings matching a fingerprint, best first, one entry per recording. Empty when no
 * API key is set or nothing matches; an invalid key throws ProviderError.
 */
export async function lookup(print: string, durationSec: number): Promise<AcoustIdMatch[]> {
  if (!(await getServerSettings()).acoustIdKeySet) return []
  const key = await getServerSecret('acoustIdKey')
  if (!key) return []
  // POST, because fingerprints are too long for a URL.
  const body = new URLSearchParams({ client: key, meta: 'recordings', duration: String(Math.round(durationSec)), fingerprint: print }).toString()
  const result = await cachedFetch(provider, 'https://api.acoustid.org/v2/lookup', {
    ttlSeconds: ttl,
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    rateLimitKey: provider,
    rateLimitMs: 334,
  })
  const raw = result.json as RawResponse | undefined
  if (result.status !== 200 || raw?.status !== 'ok') {
    throw new ProviderError(provider, raw?.error?.message ?? `HTTP ${result.status}`, result.status, raw?.error?.code)
  }
  const best = new Map<string, AcoustIdMatch>()
  for (const match of raw.results ?? []) {
    for (const recording of match.recordings ?? []) {
      if ((best.get(recording.id)?.score ?? -1) >= match.score) continue
      best.set(recording.id, {
        recordingMbid: recording.id,
        score: match.score,
        acoustId: match.id,
        title: recording.title ?? null,
        artistName: recording.artists?.map((artist) => artist.name + (artist.joinphrase ?? '')).join('') || null,
        durationMs: recording.duration ? Math.round(recording.duration * 1000) : null,
      })
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}
