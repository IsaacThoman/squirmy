import type { PlaylistSummary, TrackSummary } from '@squirmy/contracts'
import { useState } from 'react'
import { errorMessage } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { FormError } from '@/components/ui/input'
import { plural } from '@/lib/format'

/** Songs about to be added to a playlist, `repeated` of which are in it already. */
export type RepeatedAdd = { playlist: Pick<PlaylistSummary, 'id' | 'name'>; tracks: TrackSummary[]; repeated: TrackSummary[] }

type AlreadyInPlaylistDialogProps = {
  add: RepeatedAdd | null
  onOpenChange: (open: boolean) => void
  /** Adds every song, the repeated ones a second time. */
  onAddAnyway: () => Promise<unknown>
  /** Adds only the songs not in the playlist yet, if any. */
  onSkip: () => Promise<unknown>
}

/**
 * Asks before a playlist gets a song a second time: a silent duplicate is rarely wanted. It
 * closes once the songs are added, and says so here when the server refused them.
 */
export function AlreadyInPlaylistDialog({ add, onOpenChange, onAddAnyway, onSkip }: AlreadyInPlaylistDialogProps) {
  const [pending, setPending] = useState<'skip' | 'add' | null>(null)
  const [error, setError] = useState<string>()
  const change = (open: boolean) => {
    if (!open) setError(undefined)
    onOpenChange(open)
  }
  const run = async (which: 'skip' | 'add', action: () => Promise<unknown>) => {
    setPending(which)
    setError(undefined)
    try {
      await action()
      change(false)
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setPending(null)
    }
  }
  return (
    <Dialog open={add !== null} onOpenChange={change}>
      {add && (
        <DialogContent title="Already in playlist" description={describe(add)}>
          <FormError message={error} />
          <DialogFooter>
            <Button variant="outline" pending={pending === 'skip'} disabled={pending === 'add'} onClick={() => void run('skip', onSkip)}>Skip</Button>
            <Button variant="primary" pending={pending === 'add'} disabled={pending === 'skip'} onClick={() => void run('add', onAddAnyway)}>Add anyway</Button>
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
