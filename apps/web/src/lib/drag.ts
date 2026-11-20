import type { TrackSummary } from '@squirmy/contracts'

/** Tracks dragged from a list onto a sidebar playlist, onto Liked Songs, or within their own playlist. */
const tracksType = 'application/x-squirmy-tracks'

export type TrackDrag = {
  tracks: TrackSummary[]
  /** The list the rows came from and the dragged row's index, for reordering within it. */
  list: string | null
  index: number
}

type DragEventLike = { dataTransfer: DataTransfer }

// The data of a drag is only readable on drop, so the details live here for dragover.
let current: TrackDrag | null = null

export function startTrackDrag(event: DragEventLike, drag: TrackDrag) {
  current = drag
  event.dataTransfer.effectAllowed = 'copyMove'
  event.dataTransfer.setData(tracksType, drag.tracks.map(track => track.id).join(','))
  event.dataTransfer.setData('text/plain', drag.tracks.map(track => `${track.title} – ${track.artistCredit}`).join('\n'))
}

export function endTrackDrag() {
  current = null
}

/** The tracks being dragged in this window, or null when the drag is something else. */
export function draggedTracks(event: DragEventLike): TrackDrag | null {
  return event.dataTransfer.types.includes(tracksType) ? current : null
}
