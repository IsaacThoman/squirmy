import { access } from 'node:fs/promises'
import { parseFile } from 'music-metadata'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mediaFiles, sonicAnalyses } from '../../database/schema.js'
import { getServerSettings } from '../../lib/settings.js'
import { rawTags, sonicTags } from '../library/tags.js'
import { deezer } from '../metadata/index.js'
import { libraryPath } from '../streaming/files.js'
import type { SonicFeatures } from './dsp/analyzer.js'
import { analyzeAudioFile } from './decode.js'

/**
 * Bumped when the analysis changes what it measures; files analysed by an older version
 * are analysed again in the background, oldest first.
 */
export const ANALYSIS_VERSION = 1

export type AnalyzeJob = { fileId: string }
export type DeezerTempoJob = { recordingId: string; deezerId: string }

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * Reads the file's tempo, key and mood tags into `media_files.tags`. Files probed before
 * Squirmy read those tags have none; this fills them in without a full probe, which would
 * queue ingest for every album again. Skipped quietly when the tags cannot be parsed.
 */
async function readSonicTags(fileId: string, file: string) {
  const metadata = await parseFile(file, { skipCovers: true, duration: false }).catch(() => null)
  if (!metadata) return
  const found = sonicTags(metadata.common, rawTags(Object.values(metadata.native)))
  const present = Object.fromEntries(Object.entries(found).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)))
  // `updated_at` stays: album loudness is redone for files changed after it was measured.
  await db.execute(sql`
    update media_files set tags = (tags - 'bpm' - 'key' - 'moods') || ${JSON.stringify(present)}::jsonb
    where id = ${fileId} and (tags - 'bpm' - 'key' - 'moods') || ${JSON.stringify(present)}::jsonb <> tags`)
}

function featureColumns(features: SonicFeatures) {
  return {
    analyzedMs: features.analyzedMs,
    bpm: features.bpm,
    bpmConfidence: features.bpmConfidence,
    beatOffsetMs: features.beatOffsetMs,
    key: features.key,
    mode: features.mode,
    keyStrength: features.keyStrength,
    tuningCents: features.tuningCents,
    levelDb: features.levelDb,
    dynamicRangeDb: features.dynamicRangeDb,
    onsetRate: features.onsetRate,
    centroidHz: features.centroidHz,
    energy: features.energy,
    danceability: features.danceability,
    audibleStartMs: features.audibleStartMs,
    audibleEndMs: features.audibleEndMs,
    introEndMs: features.introEndMs,
    outroStartMs: features.outroStartMs,
    vector: features.vector,
  }
}

const EMPTY = featureColumns({
  analyzedMs: 0, bpm: null, bpmConfidence: 0, beatOffsetMs: null, key: null, mode: null, keyStrength: 0, tuningCents: null,
  levelDb: null, dynamicRangeDb: null, onsetRate: 0, centroidHz: null, energy: null, danceability: null,
  audibleStartMs: null, audibleEndMs: null, introEndMs: null, outroStartMs: null, vector: null,
})

/**
 * The `sonic.analyze` job: reads the file's sonic tags, then (with analysis on) decodes
 * and analyses it. A file that has gone is left for the scanner; one ffmpeg cannot decode
 * keeps the error and is not tried again until its audio or the analysis version changes.
 */
export async function analyzeFile({ fileId }: AnalyzeJob): Promise<void> {
  const [file] = await db.select().from(mediaFiles).where(and(eq(mediaFiles.id, fileId), isNull(mediaFiles.missingSince)))
  if (!file) return
  let input: string
  try {
    input = await libraryPath(file)
    await access(input)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  await readSonicTags(fileId, input)

  const enabled = (await getServerSettings()).sonicAnalysisEnabled
  let row: Partial<typeof sonicAnalyses.$inferInsert>
  if (!enabled) {
    row = { ...EMPTY, version: null, error: null }
  } else {
    try {
      const features = await analyzeAudioFile(input)
      row = { ...(features ? featureColumns(features) : EMPTY), version: ANALYSIS_VERSION, error: null }
    } catch (error) {
      if (isMissing(error)) return
      row = { ...EMPTY, version: ANALYSIS_VERSION, error: (error as Error).message.slice(0, 500) }
    }
  }
  const values = { ...row, audioHash: file.audioHash, analyzedAt: new Date() }
  await db.insert(sonicAnalyses).values({ fileId, ...values }).onConflictDoUpdate({ target: sonicAnalyses.fileId, set: values })
}

/** The `sonic.deezer-tempo` job: Deezer's tempo for a recording nothing else gives one for. */
export async function fetchDeezerTempo({ recordingId, deezerId }: DeezerTempoJob): Promise<void> {
  const track = await deezer.getTrack(Number(deezerId))
  const bpm = track?.bpm ?? null
  // The recording may have been merged away and deleted meanwhile.
  await db.execute(sql`
    insert into sonic_hints (recording_id, deezer_bpm, deezer_checked_at)
    select id, ${bpm}::real, now() from recordings where id = ${recordingId}
    on conflict (recording_id) do update set deezer_bpm = excluded.deezer_bpm, deezer_checked_at = excluded.deezer_checked_at`)
}
