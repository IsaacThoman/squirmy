import { db } from '../../database/client.js'
import { explicitBlockedFor } from '../catalog/explicit.js'
import { loadScrobbling, markConnection, usable } from './connections.js'
import { rejectsCredential, targetAvailable } from './delivery.js'
import { describeTracks, submitNowPlaying, type TrackRef } from './listens.js'

/**
 * Tells each connected and switched-on service what the user just started playing.
 * Best effort: a failure is dropped without a retry, except that a rejected credential
 * marks the connection as needing attention, as a delivery would.
 */
export async function announceNowPlaying(userId: string, play: TrackRef): Promise<void> {
  const scrobbling = await loadScrobbling(userId)
  const connections = Object.values(scrobbling.connections).filter((connection) => usable(scrobbling, connection.target))
  if (connections.length === 0) return
  // Not heard: a jam's explicit song plays silent on the device of a member who has them off.
  if (await explicitBlockedFor(userId, play.recordingId)) return
  const [track] = await describeTracks(db, [play])
  if (!track) return
  await Promise.all(connections.map(async (connection) => {
    if (!(await targetAvailable(connection.target))) return
    try {
      await submitNowPlaying(connection.target, connection.credential, track)
    } catch (error) {
      if (rejectsCredential(connection.target, error)) {
        await markConnection(connection, userId, { needsAttention: true, lastError: (error as Error).message })
      }
    }
  }))
}
