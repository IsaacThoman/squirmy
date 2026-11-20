import type { Normalization } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import { db, type Executor } from '../../database/client.js'
import { mediaFiles, releaseLoudness } from '../../database/schema.js'

/** ReplayGain 2.0 reference level. Gains bring a track to this loudness. */
export const REFERENCE_LUFS = -18

/**
 * Stored for files and albums with no measurable loudness (silence, or shorter than one
 * 400 ms gating block). It is ebur128's absolute gate, so it never yields a gain, and it is
 * not null, so the sweep does not measure the file again.
 */
export const SILENT_LUFS = -70

type FileLoudness = Pick<typeof mediaFiles.$inferSelect,
  'releaseId' | 'loudnessLufs' | 'truePeakDb' | 'tagTrackGainDb' | 'tagTrackPeak' | 'tagAlbumGainDb' | 'tagAlbumPeak'>

const measured = (lufs: number | null): lufs is number => lufs !== null && lufs > SILENT_LUFS
const gainFor = (lufs: number) => round(REFERENCE_LUFS - lufs)
const linearPeak = (db: number) => round(10 ** (db / 20), 6)
const round = (value: number, digits = 2) => Number(value.toFixed(digits))

/**
 * Normalization values for one file: gains in dB relative to -18 LUFS and linear peaks.
 * Measured loudness wins over the file's ReplayGain tags; album values come from
 * `release_loudness`, else the tags' album values. Null when nothing is known.
 */
export async function normalizationFor(file: FileLoudness, executor: Executor = db): Promise<Normalization | null> {
  const [album] = file.releaseId
    ? await executor.select().from(releaseLoudness).where(eq(releaseLoudness.releaseId, file.releaseId))
    : []
  return normalizationValues(file, album ?? null)
}

/** `normalizationFor` with the release's loudness row already loaded, for callers that batch. */
export function normalizationValues(
  file: Omit<FileLoudness, 'releaseId'>,
  album: Pick<typeof releaseLoudness.$inferSelect, 'loudnessLufs' | 'truePeakDb'> | null,
): Normalization | null {
  const track = measured(file.loudnessLufs) && file.truePeakDb !== null
    ? { gain: gainFor(file.loudnessLufs), peak: linearPeak(file.truePeakDb) }
    : { gain: file.tagTrackGainDb, peak: file.tagTrackPeak }
  const whole = album && measured(album.loudnessLufs)
    ? { gain: gainFor(album.loudnessLufs), peak: linearPeak(album.truePeakDb) }
    : { gain: file.tagAlbumGainDb, peak: file.tagAlbumPeak }
  const result = { trackGainDb: track.gain, trackPeak: track.peak, albumGainDb: whole.gain, albumPeak: whole.peak }
  return Object.values(result).every((value) => value === null) ? null : result
}
