/**
 * What is known about how recordings sound, for radio, mixes and transitions. These are
 * the sonic module's seams: radio ranks with `sonicPoints` and the index in `vectors.ts`;
 * Daily Mixes can cluster with `sonicNeighbours` and `sonicIndex`; transitions read
 * `fileTimings` (or clients `GET /tracks/:id/sonic`).
 *
 * Tempo and key come from the file's tags first (DJ software writes them, usually better
 * than a generic analysis), then from the analysis, then (tempo only) from Deezer. A
 * recording's analysis is that of its best analysed present file: lossless first, then the
 * oldest. Its files are normally one master, so they measure the same.
 */
import type { SonicFileTiming, SonicProgress, SonicSource, TrackSonic } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { notFound } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { uuidArray } from '../catalog/sql.js'
import { resolveOne } from '../catalog/redirects.js'
import { ANALYSIS_VERSION } from './analyze.js'
import { camelot, keyName, parseKey, type MusicalKey } from './keys.js'
import { centroid, neighbourhood, sonicIndex, vectorOf } from './vectors.js'

export type SonicPoint = {
  recordingId: string
  /** At least one present file of the recording has been analysed. */
  analyzed: boolean
  bpm: number | null
  bpmSource: SonicSource | null
  /** 0..1: the analysis's beat clarity; tags count as 0.9 and Deezer (often an octave off) as 0.5. */
  bpmConfidence: number
  key: MusicalKey | null
  keySource: SonicSource | null
  /** 0..1: the analysis's key strength; tags count as 0.9. */
  keyConfidence: number
  energy: number | null
  danceability: number | null
  moods: string[]
}

const TAG_CONFIDENCE = 0.9
const DEEZER_CONFIDENCE = 0.5

type FileRow = SonicFileTiming & {
  recordingId: string
  analyzed: boolean
  tagBpm: string | null
  tagKey: string | null
  tagMoods: string[] | null
  bpmConfidence: number | null
  key: number | null
  mode: 'major' | 'minor' | null
  keyStrength: number | null
  energy: number | null
  danceability: number | null
}

/** Present files of the recordings with their analyses, best first within each recording. */
async function fileRows(recordingIds: readonly string[]): Promise<FileRow[]> {
  if (recordingIds.length === 0) return []
  return db.execute<FileRow>(sql`
    select f.recording_id as "recordingId", f.id as "fileId",
      (s.version is not null and s.error is null) as analyzed,
      f.tags->>'bpm' as "tagBpm", f.tags->>'key' as "tagKey", f.tags->'moods' as "tagMoods",
      s.bpm, s.bpm_confidence as "bpmConfidence", s.beat_offset_ms as "beatOffsetMs", s.key, s.mode,
      s.key_strength as "keyStrength", s.energy, s.danceability,
      s.audible_start_ms as "audibleStartMs", s.audible_end_ms as "audibleEndMs",
      s.intro_end_ms as "introEndMs", s.outro_start_ms as "outroStartMs"
    from media_files f left join sonic_analyses s on s.file_id = f.id
    where f.recording_id = any(${uuidArray(recordingIds)}) and f.missing_since is null
    order by f.recording_id, (s.version is not null and s.error is null) desc, f.lossless desc, f.added_at, f.id`)
}

function pointOf(recordingId: string, files: FileRow[], deezerBpm: number | null): SonicPoint {
  const analysed = files.find((file) => file.analyzed)
  const tagged = files.find((file) => file.tagBpm !== null && Number.isFinite(Number(file.tagBpm)))
  const tagKey = files.map((file) => parseKey(file.tagKey)).find(Boolean) ?? null
  let bpm: Pick<SonicPoint, 'bpm' | 'bpmSource' | 'bpmConfidence'> = { bpm: null, bpmSource: null, bpmConfidence: 0 }
  if (tagged) bpm = { bpm: Number(tagged.tagBpm), bpmSource: 'tags', bpmConfidence: TAG_CONFIDENCE }
  else if (analysed?.bpm) bpm = { bpm: analysed.bpm, bpmSource: 'analysis', bpmConfidence: analysed.bpmConfidence ?? 0 }
  else if (deezerBpm) bpm = { bpm: deezerBpm, bpmSource: 'deezer', bpmConfidence: DEEZER_CONFIDENCE }
  let key: Pick<SonicPoint, 'key' | 'keySource' | 'keyConfidence'> = { key: null, keySource: null, keyConfidence: 0 }
  if (tagKey) key = { key: tagKey, keySource: 'tags', keyConfidence: TAG_CONFIDENCE }
  else if (analysed && analysed.key !== null && analysed.mode) {
    key = { key: { tonic: analysed.key, mode: analysed.mode }, keySource: 'analysis', keyConfidence: analysed.keyStrength ?? 0 }
  }
  const moods = [...new Set(files.flatMap((file) => (Array.isArray(file.tagMoods) ? file.tagMoods : [])))]
  return {
    recordingId,
    analyzed: Boolean(analysed),
    ...bpm,
    ...key,
    energy: analysed?.energy ?? null,
    danceability: analysed?.danceability ?? null,
    moods,
  }
}

/** Sonic facts of each recording that has a present file or a Deezer tempo; the rest are left out. */
export async function sonicPoints(recordingIds: readonly string[]): Promise<Map<string, SonicPoint>> {
  if (recordingIds.length === 0) return new Map()
  const [files, hints] = await Promise.all([
    fileRows(recordingIds),
    db.execute<{ id: string; bpm: number }>(sql`
      select recording_id as id, deezer_bpm as bpm from sonic_hints
      where recording_id = any(${uuidArray(recordingIds)}) and deezer_bpm is not null`),
  ])
  const byRecording = new Map<string, FileRow[]>()
  for (const file of files) byRecording.set(file.recordingId, [...(byRecording.get(file.recordingId) ?? []), file])
  const deezer = new Map(hints.map((hint) => [hint.id, hint.bpm]))
  const points = new Map<string, SonicPoint>()
  for (const id of new Set([...byRecording.keys(), ...deezer.keys()])) points.set(id, pointOf(id, byRecording.get(id) ?? [], deezer.get(id) ?? null))
  return points
}

const timing = (file: FileRow): SonicFileTiming => ({
  fileId: file.fileId,
  bpm: file.analyzed ? file.bpm : null,
  beatOffsetMs: file.analyzed ? file.beatOffsetMs : null,
  audibleStartMs: file.analyzed ? file.audibleStartMs : null,
  audibleEndMs: file.analyzed ? file.audibleEndMs : null,
  introEndMs: file.analyzed ? file.introEndMs : null,
  outroStartMs: file.analyzed ? file.outroStartMs : null,
})

/** Timing of each present file of the recordings, for transitions; by file id. */
export async function fileTimings(recordingIds: readonly string[]): Promise<Map<string, SonicFileTiming>> {
  return new Map((await fileRows(recordingIds)).map((file) => [file.fileId, timing(file)]))
}

/** `GET /tracks/:id/sonic`. */
export async function trackSonic(trackId: string): Promise<TrackSonic> {
  const id = await resolveOne('recordings', trackId)
  if (!id) throw notFound('No such track')
  const [files, points] = await Promise.all([fileRows([id]), sonicPoints([id])])
  const point = points.get(id)
  return {
    analyzed: point?.analyzed ?? false,
    bpm: point?.bpm ? Math.round(point.bpm * 10) / 10 : null,
    bpmSource: point?.bpmSource ?? null,
    key: point?.key ? keyName(point.key) : null,
    camelot: point?.key ? camelot(point.key) : null,
    keySource: point?.keySource ?? null,
    energy: point?.energy ?? null,
    danceability: point?.danceability ?? null,
    moods: point?.moods ?? [],
    files: files.map(timing),
  }
}

/** Recordings that sound most like the given ones, closest first, with a 0..1 similarity. */
export async function sonicNeighbours(recordingIds: readonly string[], options: { limit: number; exclude?: readonly string[] }): Promise<{ id: string; similarity: number }[]> {
  const index = await sonicIndex()
  const seeds = recordingIds.flatMap((id) => {
    const vector = vectorOf(index, id)
    return vector ? [{ vector, weight: 1 }] : []
  })
  const query = centroid(seeds)
  if (!query) return []
  const near = neighbourhood(index, query, options.limit, new Set([...recordingIds, ...(options.exclude ?? [])]))
  return near.nearest.map((one) => ({ id: one.id, similarity: 1 - near.percentile(one.distance) }))
}

/** How far sonic analysis has got over the collection (present files that are not cache, as the library stats count). */
export async function sonicProgress(): Promise<SonicProgress> {
  const [row] = await db.execute<Omit<SonicProgress, 'enabled'>>(sql`
    select count(*)::int as files,
      count(s.file_id) filter (where s.error is null)::int as analyzed,
      count(s.file_id) filter (where s.error is not null)::int as failed
    from media_files f
    left join sonic_analyses s on s.file_id = f.id and s.version = ${ANALYSIS_VERSION} and s.audio_hash is not distinct from f.audio_hash
    where f.missing_since is null and not f.cached`)
  return { enabled: (await getServerSettings()).sonicAnalysisEnabled, files: row?.files ?? 0, analyzed: row?.analyzed ?? 0, failed: row?.failed ?? 0 }
}
