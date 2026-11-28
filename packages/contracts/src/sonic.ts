import { z } from 'zod'
import { Id } from './common.js'

/** Where a value came from: the file's own tags, Squirmy's analysis of the audio, or Deezer. */
export const SonicSource = z.enum(['tags', 'analysis', 'deezer'])
export type SonicSource = z.infer<typeof SonicSource>

/**
 * Timing of one file's audio, from its analysis, for transitions between tracks. All in
 * milliseconds from the start of the file; null when the file is not analysed.
 */
export const SonicFileTiming = z.object({
  fileId: Id,
  /** Tempo of this file's analysis (the track's `bpm` may come from tags instead). */
  bpm: z.number().positive().nullable(),
  /** The first beat: beats fall at `beatOffsetMs + n * 60000 / bpm`. */
  beatOffsetMs: z.number().int().nonnegative().nullable(),
  /** First and last moments that are not silence. */
  audibleStartMs: z.number().int().nonnegative().nullable(),
  audibleEndMs: z.number().int().nonnegative().nullable(),
  /** Where the track first reaches its typical level (the end of a quiet intro or fade-in). */
  introEndMs: z.number().int().nonnegative().nullable(),
  /** Where it last leaves its typical level (the start of a fade-out or quiet ending). */
  outroStartMs: z.number().int().nonnegative().nullable(),
})
export type SonicFileTiming = z.infer<typeof SonicFileTiming>

/**
 * `GET /api/v1/tracks/:id/sonic`: what is known about how a track sounds. Tempo and key
 * come from the file's tags when it has them (DJ software writes better ones than a
 * generic analysis), else from Squirmy's analysis, else (tempo only) from Deezer.
 * `files` has one entry per present file of the track; the playback descriptor's `fileId`
 * says which one plays.
 */
export const TrackSonic = z.object({
  /** At least one of the track's files has been analysed. */
  analyzed: z.boolean(),
  bpm: z.number().positive().nullable(),
  bpmSource: SonicSource.nullable(),
  /** "A minor", "F# major". */
  key: z.string().nullable(),
  /** The key on the Camelot wheel DJs mix by: "8A" (A minor), "8B" (C major). */
  camelot: z.string().nullable(),
  keySource: SonicSource.nullable(),
  /** 0..1 perceived intensity: level, density of onsets, brightness. */
  energy: z.number().min(0).max(1).nullable(),
  /** 0..1 how steady and danceable the beat is. */
  danceability: z.number().min(0).max(1).nullable(),
  /** Mood tags of the file, as written. */
  moods: z.array(z.string()),
  files: z.array(SonicFileTiming),
})
export type TrackSonic = z.infer<typeof TrackSonic>

/**
 * Sonic analysis across the collection (present files that are not cache), for the admin
 * library page. Cached files are analysed too, but counted on neither side.
 */
export const SonicProgress = z.object({
  enabled: z.boolean(),
  files: z.number().int(),
  analyzed: z.number().int(),
  /** Files ffmpeg could not decode; not tried again until they change. */
  failed: z.number().int(),
})
export type SonicProgress = z.infer<typeof SonicProgress>
