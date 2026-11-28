import { loadedRecord } from './store.js'

/**
 * Whose version picks choose the file `userId` plays of `trackId`: the jam host's when
 * `userId`'s shared session follows a jam the host's loaded session still holds and the
 * host's session has the song (current, up next, autoplay or history), otherwise their own.
 * Everyone in a jam hears one edition of each song: editions differ in length, silence and
 * mastering, and the jam's clock, drift alignment and "first device to finish moves everyone
 * on" all assume the host's timeline. The file still suits each device (codecs, quality),
 * and what may play stays the listener's own (explicit content). A detached device's own
 * queue plays with its owner's picks unless the song is also the jam's.
 */
export function versionPicker(userId: string, trackId: string): string {
  const jam = loadedRecord(userId)?.session.jam
  if (jam?.role !== 'member') return userId
  const host = loadedRecord(jam.hostUserId)?.session
  if (host?.jam?.role !== 'host' || host.jam.id !== jam.id) return userId
  const holds = [host.current, ...host.queue, ...host.autoplayQueue, ...host.history].some((entry) => entry?.trackId === trackId)
  return holds ? jam.hostUserId : userId
}
