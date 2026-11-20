/**
 * What everyone is playing: Squirmy sessions that are playing, plus the songs Subsonic
 * clients announced with `scrobble?submission=false`. Those announcements live in this
 * process's memory, like the sessions themselves, and lapse once the song would be over.
 */
import { createHash } from 'node:crypto'
import { isNull } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { getDevices, getSnapshot } from '../sessions/service.js'
import type { Payload } from './protocol.js'
import { songs } from './songs.js'

type Report = { recordingId: string; client: string; at: number }

const reports = new Map<string, Report>()

export function reportNowPlaying(userId: string, recordingId: string, client: string) {
  reports.set(userId, { recordingId, client, at: Date.now() })
}

/** A finished play ends the user's announcement of that song. */
export function endNowPlaying(userId: string, recordingId: string) {
  if (reports.get(userId)?.recordingId === recordingId) reports.delete(userId)
}

/** NowPlayingEntry wants an integer player id; derive a stable one from the player's name. */
const playerId = (name: string) => Number.parseInt(createHash('sha256').update(name).digest('hex').slice(0, 7), 16)

export async function nowPlaying(): Promise<Payload[]> {
  const now = Date.now()
  const people = await db.select({ id: users.id, username: users.username }).from(users).where(isNull(users.disabledAt))
  const entries = await Promise.all(people.map(async (person): Promise<Payload[]> => {
    const found: Payload[] = []
    const report = reports.get(person.id)
    if (report) {
      const [song] = await songs(person.id, [{ id: report.recordingId }])
      const elapsed = now - report.at
      if (song && elapsed <= ((song.duration as number) + 60) * 1000) {
        found.push({ ...song, username: person.username, minutesAgo: Math.floor(elapsed / 60_000), playerId: playerId(report.client), playerName: report.client })
      } else {
        reports.delete(person.id)
      }
    }
    const { state } = await getSnapshot(person.id)
    if (state.playing && state.current) {
      const [song] = await songs(person.id, [{ id: state.current.trackId, albumId: state.current.albumId }])
      const device = state.activeDeviceId ? (await getDevices(person.id)).find((candidate) => candidate.id === state.activeDeviceId) : undefined
      const name = device?.name ?? 'Squirmy'
      if (song) found.push({ ...song, username: person.username, minutesAgo: 0, playerId: playerId(name), playerName: name })
    }
    return found
  }))
  return entries.flat()
}
