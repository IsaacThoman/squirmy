import { newId } from '../../lib/ids.js'
import { assertFileAllowed } from '../catalog/explicit.js'
import { recordExternalPlay } from '../sessions/index.js'
import { serial } from '../sessions/store.js'
import { selectFile } from '../streaming/index.js'
import { resolve } from './handlers/browsing.js'
import { expectId } from './ids.js'
import { invalidParameter, missingParameter, notFound, type Context } from './protocol.js'

type State = 'starting' | 'playing' | 'paused' | 'stopped'
type Timeline = {
  id: string
  userId: string
  recordingId: string
  albumId: string | null
  client: string
  playerKey: string
  durationMs: number
  startedAt: number
  at: number
  expiresAt: number
  state: State
  positionMs: number
  playbackRate: number
  msPlayed: number
  hasPlayed: boolean
  ignoreScrobble: boolean
}

const OFFLINE_GRACE_MS = 30 * 60_000
const DUPLICATE_GRACE_MS = 30_000
const CLOCK_SKEW_MS = 5000
const timelines = new Map<string, Timeline>()
type PlayInterval = { startedAt: number; endedAt: number }
const finished = new Map<string, PlayInterval[]>()
let lastSweep = 0
const keyOf = (user: Context['user'], client: string) => `${user.appPasswordId}:${client}`
const playKey = (key: string, recordingId: string) => `${key}:${recordingId}`

function sweep(now: number) {
  if (now - lastSweep < 60_000) return
  lastSweep = now
  for (const [key, timeline] of timelines) if (now > timeline.expiresAt) timelines.delete(key)
  for (const [key, plays] of finished) {
    const recent = plays.filter((play) => now <= play.endedAt + OFFLINE_GRACE_MS)
    if (recent.length) finished.set(key, recent)
    else finished.delete(key)
  }
}

export function timelinePosition(timeline: Timeline, now: number): number {
  const elapsed = timeline.state === 'playing' ? Math.max(0, now - timeline.at) * timeline.playbackRate : 0
  return Math.min(timeline.durationMs, timeline.positionMs + elapsed)
}

export function playbackTimelines(userIds: ReadonlySet<string>, now: number): Map<string, Timeline[]> {
  sweep(now)
  const byUser = new Map<string, Timeline[]>()
  for (const timeline of timelines.values()) {
    if (!userIds.has(timeline.userId) || now > timeline.expiresAt) continue
    const entries = byUser.get(timeline.userId) ?? []
    entries.push(timeline)
    byUser.set(timeline.userId, entries)
  }
  return byUser
}

export function reportedByTimeline(user: Context['user'], client: string, recordingId: string, playedAt?: Date): boolean {
  const now = Date.now()
  sweep(now)
  const key = keyOf(user, client)
  const current = timelines.get(key)
  const at = playedAt?.getTime()
  if (current?.recordingId === recordingId && current.state !== 'stopped' && now <= current.expiresAt
    && (at === undefined || (at >= current.startedAt - CLOCK_SKEW_MS && at <= now + CLOCK_SKEW_MS))) return !current.ignoreScrobble
  return finished.get(playKey(key, recordingId))?.some((play) => now <= play.endedAt + OFFLINE_GRACE_MS && (
    at === undefined ? now <= play.endedAt + DUPLICATE_GRACE_MS : at >= play.startedAt - CLOCK_SKEW_MS && at <= play.endedAt + DUPLICATE_GRACE_MS
  )) ?? false
}

export function serialPlayback<T>({ user, client }: Context, task: () => Promise<T>): Promise<T> {
  // Share ordering with legacy submissions from the same app credential.
  return serial(`subsonic:${keyOf(user, client)}`, task)
}

export async function reportPlayback(context: Context) {
  const { params, user, client } = context
  const mediaId = expectId(params.required('mediaId'), 'track').id
  if (params.required('mediaType') !== 'song') throw notFound('Media')
  const state = params.required('state')
  if (state !== 'starting' && state !== 'playing' && state !== 'paused' && state !== 'stopped') throw invalidParameter('state')
  const position = params.int('positionMs', undefined, { min: 0 })
  if (position === undefined) throw missingParameter('positionMs')
  if (!Number.isSafeInteger(position)) throw invalidParameter('positionMs')
  const playbackRate = Number(params.string('playbackRate') ?? '1')
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) throw invalidParameter('playbackRate')
  const ignoreScrobble = params.bool('ignoreScrobble') ?? false
  const now = Date.now()

  return serialPlayback(context, async () => {
    const recordingId = await resolve('track', mediaId)
    const selection = await selectFile(recordingId, { quality: 'original' })
    if (!selection) throw notFound('Song')
    await assertFileAllowed(user.id, selection.file)

    const key = keyOf(user, client)
    const previous = timelines.get(key)
    const matching = previous?.recordingId === recordingId && state !== 'starting'
    if (matching && (previous.state === 'stopped' || now > previous.expiresAt)) return {}

    sweep(now)
    const durationMs = matching ? previous.durationMs : selection.file.durationMs
    const positionMs = Math.min(durationMs, position)
    // Account for time advanced before re-anchoring; a seek never adds listened time.
    const msPlayed = matching ? previous.msPlayed + (timelinePosition(previous, now) - previous.positionMs) : 0
    const timeline: Timeline = {
      id: matching ? previous.id : newId(),
      userId: user.id, recordingId, albumId: selection.file.albumId, client, playerKey: key, durationMs,
      startedAt: matching ? previous.startedAt : now,
      at: now, state, positionMs, playbackRate, msPlayed,
      expiresAt: now + (durationMs - positionMs) / playbackRate + OFFLINE_GRACE_MS,
      hasPlayed: state === 'playing' || (matching && previous.hasPlayed),
      ignoreScrobble: ignoreScrobble || (matching && previous.ignoreScrobble),
    }
    if (state === 'stopped') {
      if (!matching) return {}
      if (timeline.hasPlayed && !timeline.ignoreScrobble) {
        await recordExternalPlay(user.id, recordingId, {
          id: timeline.id, playedAt: new Date(timeline.startedAt), albumId: timeline.albumId, msPlayed, durationMs,
        })
        const historyKey = playKey(key, recordingId)
        const intervals = finished.get(historyKey) ?? []
        intervals.push({ startedAt: timeline.startedAt, endedAt: now })
        finished.set(historyKey, intervals)
      }
      timeline.expiresAt = now + OFFLINE_GRACE_MS
    }
    timelines.set(key, timeline)
    return {}
  })
}
