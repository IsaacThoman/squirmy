import { UpdateServerSettings, type LibraryRoot, type ServerSettings } from '@squirmy/contracts'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Badge, Skeleton } from '@/components/ui/feedback'
import { Field, Input } from '@/components/ui/input'
import { Row, Section } from '@/components/ui/section'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { inGigabytes } from '@/lib/format'
import { AdminHeader } from './AdminLayout'
import { DraftField, SaveStatus, type SavePatch, type SaveState } from './DraftField'

type Save = SavePatch<UpdateServerSettings>
type Toggle = 'musicBrainzEnabled' | 'coverArtArchiveEnabled' | 'deezerEnabled' | 'wikidataEnabled' | 'lrclibEnabled' | 'registrationRequiresInvite' | 'wantlistEnabled'
type Secret = 'listenBrainz' | 'acoustId' | 'fanart' | 'lastFm'

type ServerSettingsProps = {
  /** Undefined while loading. */
  settings: ServerSettings | undefined
  /** The managed library folders imports can go to. */
  managedRoots: LibraryRoot[] | undefined
  onSave: Save
  status: SaveState
}

/** The import folder setting's "nothing chosen" choice; a select cannot hold null. */
const ONLY_ROOT = 'only'

/** Every operator setting. Each change is saved as soon as it is made; text fields save when they lose focus. */
export function ServerSettingsAdmin({ settings, managedRoots, onSave, status }: ServerSettingsProps) {
  const [editing, setEditing] = useState<Secret | null>(null)
  if (!settings) return <SettingsSkeleton />
  const toggle = (key: Toggle, label: string, description?: string) => (
    <Row label={label} description={description}>
      <Switch aria-label={label} checked={settings[key]} onCheckedChange={value => void onSave({ [key]: value }).catch(() => {})} />
    </Row>
  )
  const secret = (key: Secret, set: boolean, label: string, description: string) => (
    <Row label={label} description={description}>
      <Badge tone={set ? 'accent' : 'neutral'}>{set ? 'Set' : 'Not set'}</Badge>
      <Button size="sm" variant="outline" onClick={() => setEditing(key)}>{set ? 'Change' : 'Add key'}</Button>
    </Row>
  )
  return (
    <div>
      <AdminHeader title="Server settings" description="Changes apply right away.">
        <SaveStatus status={status} />
      </AdminHeader>

      <div className="flex flex-col gap-7">
        <Section title="General">
          <Row htmlFor="server-name" label="Server name" description="Shown on the sign-in page and in Subsonic apps.">
            <DraftField id="server-name" field="serverName" value={settings.serverName} schema={UpdateServerSettings} onSave={onSave} className="w-64" />
          </Row>
          {toggle('wantlistEnabled', 'Wantlist', 'Lets people keep a list of music the server does not have yet. Off hides it everywhere; wants are kept for when it is back on.')}
        </Section>

        <Section title="Registration">
          {toggle('registrationRequiresInvite', 'Require an invite to join', 'Off lets anyone who can reach this server create an account.')}
        </Section>

        <Section title="Metadata sources" description="Every source is optional. Turning one off keeps what it already provided.">
          {toggle('musicBrainzEnabled', 'MusicBrainz', 'Identifies albums and fills in discographies.')}
          <Row htmlFor="mb-url" label="MusicBrainz server" description="Point at your own mirror to lift the rate limit.">
            <DraftField id="mb-url" field="musicBrainzBaseUrl" value={settings.musicBrainzBaseUrl} schema={UpdateServerSettings} onSave={onSave} className="w-64 font-mono md:text-xs" />
          </Row>
          {toggle('coverArtArchiveEnabled', 'Cover Art Archive', 'Album covers.')}
          {toggle('deezerEnabled', 'Deezer', 'Search for music you do not have, artist images, top songs, missing covers and radio.')}
          {toggle('wikidataEnabled', 'Wikidata and Wikipedia', 'Artist images and bios, and album descriptions.')}
          {toggle('lrclibEnabled', 'LRCLIB', 'Lyrics, synced where available.')}
        </Section>

        <Section title="API keys" description="Stored encrypted. Once saved, a key is never shown again.">
          {secret('listenBrainz', settings.listenBrainzTokenSet, 'ListenBrainz', 'Top songs and popularity on artist pages, and similar artists for radio. Not used for scrobbling: each user connects their own ListenBrainz account in their settings.')}
          {secret('acoustId', settings.acoustIdKeySet, 'AcoustID', 'Identifies untagged files by fingerprint.')}
          {secret('fanart', settings.fanartKeySet, 'fanart.tv', 'Better artist images.')}
          {secret('lastFm', settings.lastFmKeySet, 'Last.fm', 'Lets users connect their Last.fm account for scrobbling.')}
        </Section>

        <Section title="Matching">
          <MatchThreshold value={settings.matchAutoAcceptScore} onSave={onSave} />
        </Section>

        <Section title="Library">
          <Row htmlFor="grace-days" label="Keep missing files for" description="An unmounted drive does not empty the library during this time.">
            <DraftField id="grace-days" field="missingFileGraceDays" value={settings.missingFileGraceDays} schema={UpdateServerSettings} onSave={onSave} type="number" inputMode="numeric" className="w-24 text-right" unit="days" />
          </Row>
        </Section>

        <ImportSettings settings={settings} managedRoots={managedRoots} onSave={onSave} />

        <Section title="Transcoding">
          <Row htmlFor="transcode-cache" label="Transcode cache" description="Converted streams are kept on disk up to this size; the oldest go first.">
            <DraftField
              id="transcode-cache" field="transcodeCacheMaxBytes" value={settings.transcodeCacheMaxBytes} schema={UpdateServerSettings} onSave={onSave}
              type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="GB" {...inGigabytes}
            />
          </Row>
        </Section>
      </div>

      {editing && <SecretDialog secret={editing} isSet={secretSet(settings, editing)} onOpenChange={open => { if (!open) setEditing(null) }} onSave={onSave} />}
    </div>
  )
}

function ImportSettings({ settings, managedRoots, onSave }: { settings: ServerSettings; managedRoots: LibraryRoot[] | undefined; onSave: Save }) {
  const roots = managedRoots ?? []
  const chosen = settings.importRootId
  const options = [
    { value: ONLY_ROOT, label: roots.length === 1 ? `${roots[0].name} (the only one)` : 'Not chosen' },
    ...roots.map(root => ({ value: root.id, label: root.name })),
    ...(chosen && managedRoots && !roots.some(root => root.id === chosen) ? [{ value: chosen, label: 'A folder that is no longer managed' }] : []),
  ]
  return (
    <Section title="Imports" description={<>Uploads and the inbox are filed into a managed music folder once they are identified. Fetched music is kept apart as a cache; see <Link to="/admin/providers" className="text-primary underline-offset-4 hover:underline">Providers</Link>.</>}>
      <Row
        label="Import into"
        description={managedRoots && roots.length === 0
          ? <>No folder is managed yet. Make one in <Link to="/admin/library" className="text-primary underline-offset-4 hover:underline">Library</Link>.</>
          : 'With several managed folders, imports wait until one is chosen.'}
      >
        {roots.length > 0 && (
          <Select label="Import into" className="w-64 max-w-full" value={chosen ?? ONLY_ROOT} options={options} onValueChange={value => void onSave({ importRootId: value === ONLY_ROOT ? null : value }).catch(() => {})} />
        )}
      </Row>
      <Row
        htmlFor="inbox-path"
        label="Inbox folder"
        description="A folder on the server to drop music into, for example from a file share. What appears there is imported and moved into the library; what cannot be imported is put in “Not imported” inside it."
      >
        <DraftField id="inbox-path" field="inboxPath" value={settings.inboxPath} schema={UpdateServerSettings} onSave={onSave} placeholder="Not set" className="w-64 font-mono md:text-xs" parse={text => text.trim() || null} />
      </Row>
      <Row htmlFor="import-file-limit" label="Largest file" description="Archives count as one file.">
        <DraftField id="import-file-limit" field="importMaxFileBytes" value={settings.importMaxFileBytes} schema={UpdateServerSettings} onSave={onSave} type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="GB" {...inGigabytes} />
      </Row>
      <Row htmlFor="import-limit" label="Largest import" description="Counting what zip archives unpack to.">
        <DraftField id="import-limit" field="importMaxBytes" value={settings.importMaxBytes} schema={UpdateServerSettings} onSave={onSave} type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="GB" {...inGigabytes} />
      </Row>
    </Section>
  )
}

function MatchThreshold({ value, onSave }: { value: number; onSave: Save }) {
  const [dragging, setDragging] = useState<number | null>(null)
  const percent = dragging ?? Math.round(value * 100)
  return (
    <Row label="Accept matches automatically above" description="Lower matches wait in the review queue.">
      <div className="flex w-64 max-w-full items-center gap-3">
        <Slider
          label="Automatic match threshold" value={percent} max={100} step={1} valueText={`${percent}%`}
          onValueChange={setDragging}
          onValueCommit={next => void onSave({ matchAutoAcceptScore: next / 100 }).catch(() => {}).finally(() => setDragging(null))}
        />
        <span className="w-10 text-right text-sm tabular">{percent}%</span>
      </div>
    </Row>
  )
}

const secrets: Record<Secret, { title: string; description: string; fields: { key: 'listenBrainzToken' | 'acoustIdKey' | 'fanartKey' | 'lastFmKey' | 'lastFmSecret'; label: string }[] }> = {
  listenBrainz: { title: 'ListenBrainz token', description: 'A user token from your ListenBrainz profile settings. The server uses it only to look up popularity and similar artists; it scrobbles nothing.', fields: [{ key: 'listenBrainzToken', label: 'User token' }] },
  acoustId: { title: 'AcoustID key', description: 'An application key from acoustid.org.', fields: [{ key: 'acoustIdKey', label: 'API key' }] },
  fanart: { title: 'fanart.tv key', description: 'A personal or project key from fanart.tv.', fields: [{ key: 'fanartKey', label: 'API key' }] },
  lastFm: { title: 'Last.fm API account', description: 'The key and shared secret of a Last.fm API account.', fields: [{ key: 'lastFmKey', label: 'API key' }, { key: 'lastFmSecret', label: 'Shared secret' }] },
}

function secretSet(settings: ServerSettings, secret: Secret): boolean {
  return { listenBrainz: settings.listenBrainzTokenSet, acoustId: settings.acoustIdKeySet, fanart: settings.fanartKeySet, lastFm: settings.lastFmKeySet }[secret]
}

/** Write-only: the dialog never sees the stored value, only whether there is one. */
function SecretDialog({ secret, isSet, onOpenChange, onSave }: { secret: Secret; isSet: boolean; onOpenChange: (open: boolean) => void; onSave: Save }) {
  const { title, description, fields } = secrets[secret]
  const [values, setValues] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<'save' | 'remove' | null>(null)
  const complete = fields.every(field => values[field.key]?.trim())
  const run = async (kind: 'save' | 'remove') => {
    setPending(kind)
    try {
      await onSave(Object.fromEntries(fields.map(field => [field.key, kind === 'save' ? values[field.key].trim() : null])))
      onOpenChange(false)
    } catch {
      // Reported by the page; the dialog stays open.
    } finally {
      setPending(null)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (complete) void run('save')
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={title} description={<>{description} {isSet && 'A key is saved; entering a new one replaces it.'}</>}>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          {fields.map((field, index) => (
            <Field key={field.key} label={field.label} htmlFor={`secret-${field.key}`}>
              <Input
                id={`secret-${field.key}`} type="password" autoComplete="off" spellCheck={false} className="font-mono"
                value={values[field.key] ?? ''} onChange={event => setValues(current => ({ ...current, [field.key]: event.target.value }))}
                autoFocus={index === 0}
              />
            </Field>
          ))}
          <DialogFooter className="sm:justify-between">
            {isSet ? <Button variant="danger" pending={pending === 'remove'} onClick={() => void run('remove')}>Remove key</Button> : <span />}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button type="submit" variant="primary" pending={pending === 'save'} disabled={!complete}>Save key</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SettingsSkeleton(): ReactNode {
  return (
    <div aria-busy>
      <AdminHeader title="Server settings" description="Changes apply right away." />
      <div className="flex flex-col gap-7">
        {[1, 1, 6, 4].map((rows, section) => (
          <div key={section} className="flex flex-col gap-3">
            <Skeleton className="h-5 w-32" />
            <div className="divide-y rounded-xl border bg-card px-4">
              {Array.from({ length: rows }, (_, row) => (
                <div key={row} className="flex items-center justify-between gap-6 py-3">
                  <div className="flex flex-1 flex-col gap-1.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-2/3 max-w-80" /></div>
                  <Skeleton className="h-5 w-8 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
