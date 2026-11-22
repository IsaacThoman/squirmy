import type { PlaybackContext } from '@squirmy/contracts'

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
