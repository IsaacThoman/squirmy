import type { TrackSummary } from '@squirmy/contracts'

/** Tracks dragged from a list onto a sidebar playlist, onto Liked Songs, the queue, the player, or within their own playlist. */
const tracksType = 'application/x-squirmy-tracks'
/** An album, playlist or mix card dragged onto a sidebar playlist, the queue or the player. */
const collectionType = 'application/x-squirmy-collection'

export type TrackDrag = {
  tracks: TrackSummary[]
  /** The list the rows came from and the dragged row's index, for reordering within it. */
  list: string | null
  index: number
}

/**
 * A card whose songs load when it is dropped. A radio's card is not one: its songs are picked
 * when it starts, so there is nothing to load until it plays.
 */
export type CollectionDrag = { kind: 'album' | 'playlist' | 'mix'; id: string; title: string }

/** What is being dragged: songs, or a collection whose songs are loaded when it is dropped. */
export type MusicDrag = { kind: 'tracks'; drag: TrackDrag } | { kind: 'collection'; collection: CollectionDrag }

type DragEventLike = { dataTransfer: DataTransfer }

// The data of a drag is only readable on drop, so the details live here for dragover.
let current: TrackDrag | null = null
let currentCollection: CollectionDrag | null = null

export function startTrackDrag(event: DragEventLike, drag: TrackDrag) {
  current = drag
  currentCollection = null
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData(tracksType, drag.tracks.map(track => track.id).join(','))
  event.dataTransfer.setData('text/plain', drag.tracks.map(track => `${track.title} – ${track.artistCredit}`).join('\n'))
}

/** A card's drag. The card is a link, so the browser's own data (its address) stays with it. */
export function startCollectionDrag(event: DragEventLike, collection: CollectionDrag) {
  currentCollection = collection
  current = null
  event.dataTransfer.effectAllowed = 'copyLink'
  event.dataTransfer.setData(collectionType, `${collection.kind}:${collection.id}`)
}

export function endTrackDrag() {
  current = null
  currentCollection = null
}

/** The tracks being dragged in this window, or null when the drag is something else. */
export function draggedTracks(event: DragEventLike): TrackDrag | null {
  return event.dataTransfer.types.includes(tracksType) ? current : null
}

/** The songs or the collection being dragged in this window, or null when the drag is something else (files, text). */
export function draggedMusic(event: DragEventLike): MusicDrag | null {
  const tracks = draggedTracks(event)
  if (tracks) return { kind: 'tracks', drag: tracks }
  return event.dataTransfer.types.includes(collectionType) && currentCollection ? { kind: 'collection', collection: currentCollection } : null
}

/**
 * Has the browser draw `text` ("3 songs") under the pointer for a drag, instead of a picture of
 * the one row it started on. The element only needs to exist while the drag starts.
 */
export function dragBadge(event: DragEventLike, text: string) {
  if (typeof event.dataTransfer.setDragImage !== 'function') return
  const badge = document.createElement('div')
  badge.textContent = text
  badge.className = 'fixed -left-[999px] top-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground shadow-md'
  document.body.append(badge)
  event.dataTransfer.setDragImage(badge, -12, -8)
  requestAnimationFrame(() => badge.remove())
}
