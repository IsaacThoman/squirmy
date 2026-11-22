import { CreatePlaylistRequest, type PlaylistSummary } from '@squirmy/contracts'
import { useState, type FormEvent } from 'react'
import { useFormSubmit } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, FormError, Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

type PlaylistDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Editing this playlist; without it the dialog creates one. */
  playlist?: Pick<PlaylistSummary, 'name' | 'description' | 'isPublic'>
  description?: string
  /** Closes the dialog once it resolves; a rejection shows in the form. */
  onSubmit: (request: CreatePlaylistRequest) => Promise<unknown>
}

/** New playlist, or a playlist's name, description and visibility. */
export function PlaylistDialog({ open, onOpenChange, ...props }: PlaylistDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <PlaylistForm key={props.playlist?.name} onDone={() => onOpenChange(false)} {...props} />}
    </Dialog>
  )
}

function PlaylistForm({ playlist, description, onSubmit, onDone }: Omit<PlaylistDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) {
  const [name, setName] = useState(playlist?.name ?? '')
  const [about, setAbout] = useState(playlist?.description ?? '')
  const [isPublic, setPublic] = useState(playlist?.isPublic ?? false)
  const form = useFormSubmit(CreatePlaylistRequest, onSubmit)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await form.submit({ name, description: about.trim() || null, isPublic })) onDone()
  }

  return (
    <DialogContent
      title={playlist ? 'Edit details' : 'New playlist'}
      description={description ?? (playlist ? undefined : 'Give it a name. You can add songs from any album, artist or search.')}
    >
      <form onSubmit={event => void submit(event)} className="flex flex-col gap-4" noValidate>
        <Field label="Name" htmlFor="playlist-name" error={form.errors.name}>
          <Input id="playlist-name" value={name} onChange={event => setName(event.target.value)} placeholder="Late night drive" maxLength={120} aria-invalid={!!form.errors.name} autoFocus />
        </Field>
        <Field label="Description" htmlFor="playlist-description" hint="Optional" error={form.errors.description}>
          <Input id="playlist-description" value={about} onChange={event => setAbout(event.target.value)} placeholder="What it's for" maxLength={2000} />
        </Field>
        <label className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Visible to everyone on this server</span>
            <span className="block text-xs text-muted-foreground">Other members can find and play it.</span>
          </span>
          <Switch checked={isPublic} onCheckedChange={setPublic} aria-label="Visible to everyone on this server" />
        </label>
        <FormError message={form.errors.form} />
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button type="submit" variant="primary" pending={form.pending} disabled={!name.trim()}>{playlist ? 'Save' : 'Create'}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
