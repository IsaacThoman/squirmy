import { CreateShareRequest, type ShareExpiry, type ShareKind, type ShareLink } from '@squirmy/contracts'
import { Link2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useFormSubmit } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, FormError } from '@/components/ui/input'
import { Select, type SelectOption } from '@/components/ui/select'

/** What a share link is made for: an album, a playlist, or a track (with the album it was shared from). */
export type ShareTarget = { kind: ShareKind; id: string; albumId?: string | null; title: string }

const expiryOptions: SelectOption<ShareExpiry>[] = [
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'never', label: 'Until I revoke it' },
]

const kindNames: Record<ShareKind, string> = { album: 'album', playlist: 'playlist', track: 'song' }

type ShareDialogProps = {
  target: ShareTarget | null
  onOpenChange: (open: boolean) => void
  /** Resolves with the new link, whose `url` is shown once. */
  onCreate: (request: CreateShareRequest) => Promise<ShareLink>
}

/** Makes a public link: pick how long it lasts, then copy it. The link is shown only here. */
export function ShareDialog({ target, onOpenChange, ...props }: ShareDialogProps) {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      {target && <ShareForm key={`${target.kind}:${target.id}`} target={target} {...props} />}
    </Dialog>
  )
}

function ShareForm({ target, onCreate }: Omit<ShareDialogProps, 'target' | 'onOpenChange'> & { target: ShareTarget }) {
  const [expiresIn, setExpiresIn] = useState<ShareExpiry>('7d')
  const [link, setLink] = useState<ShareLink | null>(null)
  const form = useFormSubmit(CreateShareRequest, async request => setLink(await onCreate(request)))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    await form.submit({ kind: target.kind, id: target.id, albumId: target.albumId ?? null, expiresIn })
  }

  if (link?.url) {
    return (
      <DialogContent title="Link created" description={`Anyone with this link can see ${target.title}, without an account.`}>
        <CopyField value={new URL(link.url, window.location.origin).toString()} label="Share link" />
        <p className="text-xs text-muted-foreground">
          Copy it now: for your safety the link is not shown again. Revoke it any time in Settings, under Share links.
        </p>
        <DialogFooter>
          <DialogClose asChild><Button variant="primary">Done</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    )
  }

  return (
    <DialogContent title={`Share ${kindNames[target.kind]}`} description={`Make a public link to ${target.title}. People who open it see its songs and can listen, as this server allows, without an account.`}>
      <form onSubmit={event => void submit(event)} className="flex flex-col gap-4" noValidate>
        <Field label="Link works for" htmlFor="share-expiry">
          <Select id="share-expiry" label="Link works for" value={expiresIn} options={expiryOptions} onValueChange={setExpiresIn} className="w-full" />
        </Field>
        <FormError message={form.errors.form ?? form.errors.id} />
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button type="submit" variant="primary" pending={form.pending}><Link2 />Create link</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
