import { SLEEP_FADE_MS, type PlaybackContext, type QueueEntry, type SessionState, type SleepTimer, type SleepTimerRequest } from '@squirmy/contracts'
import { formatDuration } from '../format.js'
import { positionAt } from './reducer.js'

/** What the timer's arithmetic reads of a session and its queue (a whole `Session` will do). */
export type SleepView = Pick<SessionState, 'sleepTimer' | 'current' | 'repeat' | 'context' | 'playing' | 'stalled' | 'positionMs' | 'anchorAt'>
  & { queue: readonly QueueEntry[] }

/**
 * The sleep timer as the apps show it (see "Sleep timer" in the session contract). One set of
 * choices and words for the web, iOS and Apple TV.
 */

export type SleepTimerChoice = { id: string; label: string; request: SleepTimerRequest }

const minutes = (count: number): SleepTimerRequest => ({ kind: 'time', durationMs: count * 60_000 })

/** The lengths offered, shortest first. */
export const SLEEP_TIMER_LENGTHS: readonly SleepTimerChoice[] = [
  { id: '5', label: '5 minutes', request: minutes(5) },
  { id: '10', label: '10 minutes', request: minutes(10) },
  { id: '15', label: '15 minutes', request: minutes(15) },
  { id: '30', label: '30 minutes', request: minutes(30) },
  { id: '45', label: '45 minutes', request: minutes(45) },
  { id: '60', label: '1 hour', request: minutes(60) },
]

/**
 * Everything a sleep timer menu offers, in order: the lengths, then the end of the song and the
 * end of what plays from the queue, named after where it was started ("End of album").
 */
export function sleepTimerChoices(context: PlaybackContext | null | undefined): SleepTimerChoice[] {
  return [
    ...SLEEP_TIMER_LENGTHS,
    { id: 'track', label: 'End of song', request: { kind: 'track' } },
    { id: 'queue', label: endOfQueueLabel(context), request: { kind: 'queue' } },
  ]
}

function endOfQueueLabel(context: PlaybackContext | null | undefined): string {
  if (context?.type === 'album') return 'End of album'
  if (context?.type === 'playlist') return 'End of playlist'
  return 'End of queue'
}

/** The id of the choice `timer` was set with, for a check mark; null for none, or a length no choice has. */
export function sleepTimerChoiceId(timer: SleepTimer | undefined): string | null {
  if (!timer) return null
  if (timer.kind !== 'time') return timer.kind
  return SLEEP_TIMER_LENGTHS.find(choice => choice.request.kind === 'time' && choice.request.durationMs === timer.durationMs)?.id ?? null
}

/**
 * Milliseconds until the sleep timer stops playback, at server time `now`. For the end of the
 * song or the queue, from `positionMs` (the session's position by default; the engine's on the
 * device that plays) and the lengths of what is left; null when that is not known (a length
 * the server has not learned yet, repeat one, nothing current) or no timer is set.
 */
export function sleepRemainingMs(session: SleepView, now: number, positionMs = positionAt(session, now)): number | null {
  const timer = session.sleepTimer
  if (!timer) return null
  if (timer.kind === 'time') return Math.max(0, timer.endsAt - now)
  const { current } = session
  if (!current || current.durationMs <= 0 || current.state === 'failed') return null
  const left = Math.max(0, current.durationMs - positionMs)
  if (timer.kind === 'track') return left
  if (session.repeat === 'one') return null
  let total = left
  for (const entry of session.queue) {
    if (entry.state === 'failed') continue
    if (entry.durationMs <= 0) return null
    total += entry.durationMs
  }
  return total
}

/**
 * How loud the device that plays should be because of the sleep timer, 0 to 1: full until
 * `SLEEP_FADE_MS` before it stops playback, then down to silence, linearly. Full while no
 * timer is set or its end is not known.
 */
export function sleepFade(session: SleepView, now: number, positionMs?: number): number {
  const remaining = sleepRemainingMs(session, now, positionMs)
  if (remaining === null) return 1
  return Math.min(1, Math.max(0, remaining / SLEEP_FADE_MS))
}

/**
 * The short line a player shows while a timer is set, beside a moon: the time left (`12:04`,
 * `1:00:00`), rounded up to the second, or what it waits for when that is not known.
 */
export function sleepTimerLabel(session: SleepView, now: number, positionMs?: number): string | null {
  const timer = session.sleepTimer
  if (!timer) return null
  const remaining = sleepRemainingMs(session, now, positionMs)
  if (remaining === null) return timer.kind === 'track' ? 'End of song' : endOfQueueLabel(session.context)
  return formatClock(remaining)
}

/** A time left as `m:ss`, or `h:mm:ss` from an hour, rounded up to the second. */
function formatClock(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 3600) return formatDuration(seconds * 1000)
  const hours = Math.floor(seconds / 3600)
  const rest = formatDuration((seconds % 3600) * 1000)
  return `${hours}:${rest.padStart(5, '0')}`
}

/** What a screen reader says of the timer: "Sleep timer, 12:04 left", "Sleep timer, end of song". */
export function sleepTimerAccessibilityLabel(session: SleepView, now: number, positionMs?: number): string | null {
  const label = sleepTimerLabel(session, now, positionMs)
  if (label === null) return null
  return /^\d/.test(label) ? `Sleep timer, ${label} left` : `Sleep timer, ${label.toLowerCase()}`
}
