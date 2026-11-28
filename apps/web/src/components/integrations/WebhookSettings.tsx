import { CreateWebhook, WebhookEventType, type Webhook } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { errorMessage, useFormSubmit } from '@/api/errors'
import { useApi } from '@/api/services'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, FormError, Input } from '@/components/ui/input'
import { loadFailure } from '@/components/ui/load-failure'
import { Row, Section } from '@/components/ui/section'

const eventLabels: Record<WebhookEventType, string> = {
  'playback.started': 'Playback started',
  'playback.paused': 'Playback paused',
  'playback.stopped': 'Playback stopped',
  'playback.track_changed': 'Track changed',
  scrobble: 'Scrobble',
  'library.scan_finished': 'Library scan finished',
  'library.album_added': 'Album added',
  'import.finished': 'Import finished',
}

export function WebhookSettings({ admin = false }: { admin?: boolean }) {
  const api = useApi().integrations
  const queryClient = useQueryClient()
  const key = ['webhooks', admin] as const
  const hooks = useQuery({ queryKey: key, queryFn: admin ? api.webhooks : api.personalWebhooks })
  const refresh = () => queryClient.invalidateQueries({ queryKey: key })
  const create = useMutation({ mutationFn: admin ? api.createWebhook : api.createPersonalWebhook, onSuccess: refresh })
  const remove = useMutation({ mutationFn: admin ? api.deleteWebhook : api.deletePersonalWebhook, onSuccess: refresh })
  const test = useMutation({ mutationFn: admin ? api.testWebhook : api.testPersonalWebhook })
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Webhook | null>(null)
  return (
    <Section title="Webhooks" description={admin ? 'Send events from across this server.' : 'Send your playback, scrobbles, imports, and shared library events.'}
      action={<Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus />Add webhook</Button>}
    >
      {loadFailure(hooks, 'Webhooks did not load')}
      {hooks.data?.length === 0 && <p className="text-sm text-muted-foreground">No webhooks configured.</p>}
      {hooks.data?.map(hook => (
        <Row key={hook.id} label={hook.name} description={<span className="break-all">{hook.url}<br />{hook.events.map(event => eventLabels[event]).join(', ')}</span>}>
          <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate(hook.id)}>Send test</Button>
          <Button size="sm" variant="outline" onClick={() => setRemoving(hook)}>Remove</Button>
        </Row>
      ))}
      {test.isSuccess && <p role="status" className="text-sm">Test queued.</p>}
      <FormError message={test.isError ? errorMessage(test.error) : undefined} />
      {adding && <WebhookDialog onClose={() => setAdding(false)} onCreate={create.mutateAsync} />}
      <ConfirmDialog
        open={!!removing} onOpenChange={open => { if (!open) setRemoving(null) }}
        title="Remove webhook?" description={removing?.name} confirmLabel="Remove"
        onConfirm={() => remove.mutateAsync(removing!.id)}
      />
    </Section>
  )
}

function WebhookDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (body: CreateWebhook) => Promise<Webhook> }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<WebhookEventType[]>([])
  const [created, setCreated] = useState<Webhook>()
  const form = useFormSubmit(CreateWebhook, async body => setCreated(await onCreate(body)))
  return (
    <Dialog open onOpenChange={open => { if (!open) onClose() }}>
      <DialogContent title={created ? 'Copy signing secret' : 'Add webhook'} description={created ? 'The signing secret is shown once. Save it in your receiver.' : undefined}>
        {created ? <CopyField label="Signing secret" value={created.secret ?? ''} /> : (
          <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void form.submit({ name, url, events }) }}>
            <Field label="Name" htmlFor="webhook-name" error={form.errors.name}>
              <Input id="webhook-name" value={name} onChange={event => setName(event.target.value)} />
            </Field>
            <Field label="Destination URL" htmlFor="webhook-url" error={form.errors.url}>
              <Input id="webhook-url" type="url" value={url} onChange={event => setUrl(event.target.value)} />
            </Field>
            <fieldset className="grid gap-2 text-sm sm:grid-cols-2">
              <legend className="mb-2 font-medium">Events</legend>
              {WebhookEventType.options.map(type => (
                <label key={type} className="flex items-center gap-2">
                  <input type="checkbox" checked={events.includes(type)} onChange={event => setEvents(current => event.target.checked ? [...current, type] : current.filter(value => value !== type))} />
                  {eventLabels[type]}
                </label>
              ))}
            </fieldset>
            <FormError message={form.errors.events ?? form.errors.form} />
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button type="submit" variant="primary" pending={form.pending} disabled={!name.trim() || !url.trim() || !events.length}>Add webhook</Button>
            </DialogFooter>
          </form>
        )}
        {created && <DialogFooter><DialogClose asChild><Button>Done</Button></DialogClose></DialogFooter>}
      </DialogContent>
    </Dialog>
  )
}
