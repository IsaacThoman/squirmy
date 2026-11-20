import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getConfig } from '../../config.js'
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

const run = promisify(execFile)
const provider = 'acoustid'
const ttl = 30 * 86400

/**
 * Fingerprints an audio file with `fpcalc -json` (FPCALC_PATH). Null when fpcalc is not
 * installed; throws when it cannot decode the file.
 */
export async function fingerprint(filePath: string): Promise<Fingerprint | null> {
  try {
    const { stdout } = await run(getConfig().FPCALC_PATH, ['-json', filePath], { maxBuffer: 16 * 1024 * 1024 })
    const parsed = JSON.parse(stdout) as { fingerprint: string; duration: number }
    return { fingerprint: parsed.fingerprint, durationSec: Math.round(parsed.duration) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
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
