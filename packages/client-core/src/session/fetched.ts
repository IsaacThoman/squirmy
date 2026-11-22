import type { QueueEntry } from '@squirmy/contracts'
import type { TrackStore } from '../tracks.js'
import type { SessionClientSnapshot } from './client.js'

type Entries = Pick<SessionClientSnapshot, 'session' | 'queue'>

function entriesOf({ session, queue }: Entries): QueueEntry[] {
  return [session.current, ...queue.queue, ...queue.autoplayQueue, ...queue.history].filter((entry): entry is QueueEntry => entry !== null)
}

/** Entries that were preparing before and are ready now: the server fetched them. */
export function newlyReady(before: Entries, after: Entries): QueueEntry[] {
  const preparing = new Set(entriesOf(before).filter(entry => entry.state === 'preparing').map(entry => entry.id))
  return entriesOf(after).filter(entry => entry.state === 'ready' && preparing.has(entry.id))
}

/**
 * Reads a track's summary again once the server has fetched it. An on-demand track gains
 * its album and cover with its file, and the summary taken when it was queued has
 * neither, so the player, the queue and the system's media controls would keep a blank
 * cover. Returns a function that stops watching.
 */
export function refreshFetchedTracks(
  client: { getSnapshot: () => Entries; subscribe: (listener: () => void) => () => void },
  store: Pick<TrackStore, 'refresh'>,
): () => void {
  let last = client.getSnapshot()
  return client.subscribe(() => {
    const next = client.getSnapshot()
    const ready = newlyReady(last, next)
    last = next
    for (const entry of ready) store.refresh(entry.trackId, entry.albumId)
  })
}
