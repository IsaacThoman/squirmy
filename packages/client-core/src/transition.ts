import type { PlaybackTiming } from '@squirmy/contracts'

/**
 * Where a crossfade between two songs starts and ends, from the crossfade length set and the
 * songs' timing (the playback descriptor's `timing`, from the server's sonic analysis). Both
 * crossfading engines follow it: the web's `CrossfadeEngine` here, and the iOS engine through
 * its Swift twin (`TransitionPlan` in `modules/audio-engine/core`), which has the same rules
 * and the same tests. Gapless playback, and songs that continue an album, never use it.
 *
 * - The fade is the length set, but no more than half of either song.
 * - Silence is skipped: the fade ends where the outgoing song falls silent (`audibleEndMs`)
 *   rather than at the end of its file, and the incoming song starts where its sound does
 *   (`audibleStartMs`).
 * - With Smart transitions, the fade lasts as long as the longer of the outgoing song's
 *   outro (from `outroStartMs` to its silence) and the incoming song's intro (from its sound
 *   to `introEndMs`), at least `SMART_SHORTEST_MS` and at most the length set: a song that
 *   fades out is mixed over its fade-out, one that stops dead is cut close to the next.
 *
 * Timing that does not fit the song (an end before its middle, a start after it) is ignored,
 * so a bad analysis costs a little silence, never music.
 */
export type TransitionSide = {
  /** The song's length, when known. */
  durationMs: number | null | undefined
  timing?: PlaybackTiming | null
}

export type TransitionPlan = {
  /** How long both songs play together. */
  fadeMs: number
  /** Where the outgoing song falls silent: the fade ends here and the song stops. */
  outgoingEndMs: number
  /** Where the incoming song starts when the fade does. */
  incomingStartMs: number
}

/** The shortest fade Smart transitions make between two songs with hard edges. */
export const SMART_SHORTEST_MS = 1000

export function crossfadePlan(outgoing: TransitionSide & { durationMs: number }, incoming: TransitionSide, options: { seconds: number; smart: boolean }): TransitionPlan {
  const outLength = outgoing.durationMs
  const inLength = incoming.durationMs ?? Infinity
  const fade = Math.max(0, Math.min(options.seconds * 1000, outLength / 2, inLength / 2))
  const out = outgoing.timing
  const into = incoming.timing
  const end = within(out?.audibleEndMs, outLength / 2, outLength) ?? outLength
  const start = within(into?.audibleStartMs, 0, inLength / 2) ?? 0
  if (!options.smart) return { fadeMs: fade, outgoingEndMs: end, incomingStartMs: start }
  const outroStart = within(out?.outroStartMs, outLength / 2, end)
  const introEnd = within(into?.introEndMs, start, inLength / 2)
  if (outroStart === null && introEnd === null) return { fadeMs: fade, outgoingEndMs: end, incomingStartMs: start }
  const span = Math.max(outroStart === null ? 0 : end - outroStart, introEnd === null ? 0 : introEnd - start)
  return { fadeMs: Math.min(fade, Math.max(SMART_SHORTEST_MS, span)), outgoingEndMs: end, incomingStartMs: start }
}

/** `value` when it is a number from `low` to `high`, else null. */
function within(value: number | null | undefined, low: number, high: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high ? value : null
}
