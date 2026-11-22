import type { PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { plural } from '@/lib/format'

/** Songs about to be added to a playlist, `repeated` of which are in it already. */
export type RepeatedAdd = { playlist: Pick<PlaylistSummary, 'id' | 'name'>; tracks: TrackSummary[]; repeated: TrackSummary[] }

type AlreadyInPlaylistDialogProps = {
  add: RepeatedAdd | null
  onOpenChange: (open: boolean) => void
  /** Adds every song, the repeated ones a second time. */
  onAddAnyway: () => void
  /** Adds only the songs not in the playlist yet, if any. */
  onSkip: () => void
}

/** Asks before a playlist gets a song a second time: a silent duplicate is rarely wanted. */
export function AlreadyInPlaylistDialog({ add, onOpenChange, onAddAnyway, onSkip }: AlreadyInPlaylistDialogProps) {
  return (
    <Dialog open={add !== null} onOpenChange={onOpenChange}>
      {add && (
        <DialogContent title="Already in playlist" description={describe(add)}>
          <DialogFooter>
            <Button variant="outline" onClick={onSkip}>Skip</Button>
            <Button variant="primary" onClick={onAddAnyway}>Add anyway</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

function describe({ playlist, tracks, repeated }: RepeatedAdd): string {
  const name = `“${playlist.name}”`
  if (tracks.length === 1) return `“${tracks[0].title}” is already in ${name}.`
  if (repeated.length === tracks.length) return `All ${plural(tracks.length, 'song')} are already in ${name}.`
  return `${repeated.length} of these ${plural(tracks.length, 'song')} are already in ${name}. Skip adds only the other ${plural(tracks.length - repeated.length, 'song')}.`
}
