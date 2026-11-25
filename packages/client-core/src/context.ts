import type { PlaybackContext, QueueEntry } from '@squirmy/contracts'

/**
 * What a player shows of the session's context, the same on every app: a short heading
 * ("Playing from album") over the context's name. Null when there is nothing worth saying,
 * as for a context without a name.
 */
export type ContextLabel = { heading: string; title: string }

export function contextLabel(context: PlaybackContext | null | undefined): ContextLabel | null {
  const title = context?.title?.trim()
  switch (context?.type) {
    case 'album':
    case 'playlist':
    case 'artist':
    case 'radio':
      return title ? { heading: `Playing from ${context.type}`, title } : null
    case 'search':
      return title ? { heading: 'Playing from search', title: `“${title}”` } : null
    case 'liked':
      return { heading: 'Playing from', title: title || 'Liked Songs' }
    case 'history':
      return { heading: 'Playing from', title: title || 'Recently played' }
    case 'other':
      return title ? { heading: 'Playing from', title } : null
    default:
      return null
  }
}

/** The context of tracks played from the results of `query`, which names it. */
export function searchContext(query: string): PlaybackContext {
  return { type: 'search', id: null, title: query.trim() || null }
}

/**
 * The line under the queue's Up next heading: where the songs come from, as Apple Music's
 * "From …", while every one of them does; once the user has queued songs of their own among
 * them (`queued`), or there is no context, how many there are. Null for an empty queue.
 */
export function upNextDetail(context: { title: string } | null, entries: readonly Pick<QueueEntry, 'queued'>[]): string | null {
  const count = entries.length
  if (!count) return null
  if (context && !entries.some(entry => entry.queued)) return `From ${context.title}`
  return `${count} ${count === 1 ? 'song' : 'songs'}`
}

/**
 * The heading of the queue's Up next: Apple Music's "Continue Playing" while every song in it
 * comes from what is playing (its line says "From …"), otherwise "Up Next".
 */
export function upNextTitle(context: { title: string } | null, entries: readonly Pick<QueueEntry, 'queued'>[]): string {
  return context && entries.length && !entries.some(entry => entry.queued) ? 'Continue Playing' : 'Up Next'
}
