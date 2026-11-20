import type { CreatePlaylistRequest } from '@squirmy/contracts'
import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

type CreatePlaylistDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (request: CreatePlaylistRequest) => void
}

export function CreatePlaylistDialog({ open, onOpenChange, onCreate }: CreatePlaylistDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isPublic, setPublic] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    onCreate({ name: name.trim(), description: description.trim() || null, isPublic })
    setName('')
    setDescription('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New playlist" description="Give it a name. You can add songs from any album, artist or search.">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Name" htmlFor="playlist-name">
            <Input id="playlist-name" value={name} onChange={event => setName(event.target.value)} placeholder="Late night drive" maxLength={120} autoFocus required />
          </Field>
          <Field label="Description" htmlFor="playlist-description" hint="Optional">
            <Input id="playlist-description" value={description} onChange={event => setDescription(event.target.value)} placeholder="What it's for" />
          </Field>
          <label className="flex items-center justify-between gap-4 rounded-xl bg-surface px-3.5 py-3">
            <span>
              <span className="block text-sm font-semibold">Visible to everyone on this server</span>
              <span className="block text-xs text-muted">Other members can find and play it.</span>
            </span>
            <Switch checked={isPublic} onCheckedChange={setPublic} />
          </label>
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" disabled={!name.trim()}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
