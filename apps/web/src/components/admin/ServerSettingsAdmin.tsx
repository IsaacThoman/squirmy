import { UpdateServerSettings, type ServerSettings } from '@squirmy/contracts'
import { Check } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { errorsFromIssues } from '@/api/errors'
import { SettingRow, SettingsSection } from '@/components/layout/Settings'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Badge, Skeleton, Spinner } from '@/components/ui/feedback'
import { Field, Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { AdminHeader } from './AdminLayout'

type Save = (patch: UpdateServerSettings) => Promise<unknown>
type Toggle = 'musicBrainzEnabled' | 'coverArtArchiveEnabled' | 'deezerEnabled' | 'wikidataEnabled' | 'lrclibEnabled' | 'registrationRequiresInvite'
type Secret = 'listenBrainz' | 'acoustId' | 'fanart' | 'lastFm'

const GIB = 1024 ** 3

type ServerSettingsProps = {
  /** Undefined while loading. */
  settings: ServerSettings | undefined
  onSave: Save
  status: 'idle' | 'saving' | 'saved'
}

/** Every operator setting. Each change is saved as soon as it is made; text fields save when they lose focus. */
export function ServerSettingsAdmin({ settings, onSave, status }: ServerSettingsProps) {
  const [editing, setEditing] = useState<Secret | null>(null)
  if (!settings) return <SettingsSkeleton />
  const toggle = (key: Toggle, label: string, description?: string) => (
    <SettingRow label={label} description={description}>
      <Switch aria-label={label} checked={settings[key]} onCheckedChange={value => void onSave({ [key]: value }).catch(() => {})} />
    </SettingRow>
  )
  const secret = (key: Secret, set: boolean, label: string, description: string) => (
    <SettingRow label={label} description={description}>
      <Badge tone={set ? 'accent' : 'neutral'}>{set ? 'Set' : 'Not set'}</Badge>
      <Button size="sm" variant="outline" onClick={() => setEditing(key)}>{set ? 'Change' : 'Add key'}</Button>
    </SettingRow>
  )
  return (
    <div className="flex flex-col gap-9">
      <AdminHeader title="Server settings" description="Changes apply right away.">
        <SaveStatus status={status} />
      </AdminHeader>

      <SettingsSection title="General" className="-mt-6">
        <SettingRow htmlFor="server-name" label="Server name" description="Shown on the sign-in page and in Subsonic apps.">
          <DraftField id="server-name" field="serverName" value={settings.serverName} onSave={onSave} className="w-48" />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Registration">
        {toggle('registrationRequiresInvite', 'Require an invite to join', 'Off lets anyone who can reach this server create an account.')}
      </SettingsSection>

      <SettingsSection title="Metadata sources" description="Every source is optional. Turning one off keeps what it already provided.">
        {toggle('musicBrainzEnabled', 'MusicBrainz', 'Identifies albums and fills in discographies.')}
        <SettingRow htmlFor="mb-url" label="MusicBrainz server" description="Point at your own mirror to lift the rate limit.">
          <DraftField id="mb-url" field="musicBrainzBaseUrl" value={settings.musicBrainzBaseUrl} onSave={onSave} className="w-64 font-mono text-[13px]" />
        </SettingRow>
        {toggle('coverArtArchiveEnabled', 'Cover Art Archive', 'Album covers.')}
        {toggle('deezerEnabled', 'Deezer', 'Search, artist images and top songs.')}
        {toggle('wikidataEnabled', 'Wikidata and Wikipedia', 'Artist images and bios.')}
        {toggle('lrclibEnabled', 'LRCLIB', 'Synced lyrics.')}
      </SettingsSection>

      <SettingsSection title="API keys" description="Stored encrypted. Once saved, a key is never shown again.">
        {secret('listenBrainz', settings.listenBrainzTokenSet, 'ListenBrainz', 'Top songs, similar artists and scrobbling.')}
        {secret('acoustId', settings.acoustIdKeySet, 'AcoustID', 'Identifies untagged files by fingerprint.')}
        {secret('fanart', settings.fanartKeySet, 'fanart.tv', 'Better artist images.')}
        {secret('lastFm', settings.lastFmKeySet, 'Last.fm', 'Scrobbling for users who connect an account.')}
      </SettingsSection>

      <SettingsSection title="Matching">
        <MatchThreshold value={settings.matchAutoAcceptScore} onSave={onSave} />
      </SettingsSection>

      <SettingsSection title="Library">
        <SettingRow htmlFor="grace-days" label="Keep missing files for" description="An unmounted drive does not empty the library during this time.">
          <DraftField id="grace-days" field="missingFileGraceDays" value={settings.missingFileGraceDays} onSave={onSave} type="number" inputMode="numeric" className="w-20 text-right" unit="days" />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Transcoding">
        <SettingRow htmlFor="transcode-cache" label="Transcode cache" description="Converted streams are kept on disk up to this size; the oldest go first.">
          <DraftField
            id="transcode-cache" field="transcodeCacheMaxBytes" value={settings.transcodeCacheMaxBytes} onSave={onSave}
            type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="GB"
            format={bytes => String(Math.round((bytes / GIB) * 10) / 10)} parse={text => Math.round(Number(text) * GIB)}
          />
        </SettingRow>
      </SettingsSection>

      {editing && <SecretDialog secret={editing} isSet={secretSet(settings, editing)} onOpenChange={open => { if (!open) setEditing(null) }} onSave={onSave} />}
    </div>
  )
}

function SaveStatus({ status }: { status: ServerSettingsProps['status'] }) {
  if (status === 'idle') return null
  return (
    <span role="status" className="flex h-10 items-center gap-2 text-sm font-semibold text-muted">
      {status === 'saving' ? <><Spinner className="size-4" label="Saving" />Saving…</> : <><Check className="size-4 text-accent" />Saved</>}
    </span>
  )
}

type Editable = Exclude<keyof UpdateServerSettings, Toggle>

type DraftFieldProps<K extends Editable> = {
  id: string
  field: K
  value: NonNullable<UpdateServerSettings[K]>
  onSave: Save
  className?: string
  unit?: string
  type?: 'text' | 'number'
  inputMode?: 'numeric' | 'decimal'
  step?: string
  format?: (value: NonNullable<UpdateServerSettings[K]>) => string
  parse?: (text: string) => unknown
}

/**
 * An input that saves on blur or Enter. Until then it holds a draft, checked with the
 * contract schema; a value the server refuses stays in the field to be corrected.
 */
function DraftField<K extends Editable>({ id, field, value, onSave, className, unit, type = 'text', inputMode, step, format = String, parse }: DraftFieldProps<K>) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const toValue = parse ?? (type === 'number' ? (text: string) => (text.trim() ? Number(text) : Number.NaN) : (text: string) => text.trim())
  const commit = async () => {
    if (draft === null) return
    const next = toValue(draft)
    const parsed = UpdateServerSettings.safeParse({ [field]: next })
    if (!parsed.success) return setError(errorsFromIssues(parsed.error.issues)[field])
    setError(undefined)
    if (next === value) return setDraft(null)
    try {
      await onSave({ [field]: next })
      setDraft(null)
    } catch {
      // The failure is reported by the page; the draft stays for another try.
    }
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Input
          id={id} type={type} inputMode={inputMode} step={step} min={type === 'number' ? 0 : undefined}
          value={draft ?? format(value)}
          onChange={event => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          className={cn('h-9', className)}
        />
        {unit && <span className="text-sm text-muted">{unit}</span>}
      </div>
      {error && <p id={`${id}-error`} className="text-xs font-medium text-danger">{error}</p>}
    </div>
  )
}

function MatchThreshold({ value, onSave }: { value: number; onSave: Save }) {
  const [dragging, setDragging] = useState<number | null>(null)
  const percent = dragging ?? Math.round(value * 100)
  return (
    <SettingRow label="Accept matches automatically above" description="Lower matches wait in the review queue.">
      <div className="flex w-56 items-center gap-3">
        <Slider
          label="Automatic match threshold" value={percent} max={100} step={1} valueText={`${percent}%`}
          onValueChange={setDragging}
          onValueCommit={next => void onSave({ matchAutoAcceptScore: next / 100 }).catch(() => {}).finally(() => setDragging(null))}
        />
        <span className="w-10 text-right text-sm font-semibold tabular">{percent}%</span>
      </div>
    </SettingRow>
  )
}

const secrets: Record<Secret, { title: string; description: string; fields: { key: 'listenBrainzToken' | 'acoustIdKey' | 'fanartKey' | 'lastFmKey' | 'lastFmSecret'; label: string }[] }> = {
  listenBrainz: { title: 'ListenBrainz token', description: 'From your ListenBrainz profile settings.', fields: [{ key: 'listenBrainzToken', label: 'User token' }] },
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
            {isSet ? <Button variant="ghost" className="text-danger" pending={pending === 'remove'} onClick={() => void run('remove')}>Remove key</Button> : <span />}
            <div className="flex gap-2">
              <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
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
    <div className="flex flex-col gap-9" aria-busy>
      <AdminHeader title="Server settings" description="Changes apply right away." />
      {[3, 5, 4].map((rows, section) => (
        <div key={section} className="-mt-3 flex flex-col gap-3">
          <Skeleton className="ml-1 h-6 w-40" />
          <div className="divide-y divide-stroke rounded-2xl bg-sheet ring-1 ring-stroke">
            {Array.from({ length: rows }, (_, row) => <div key={row} className="px-4 py-4"><Skeleton className="h-5 w-2/3" /></div>)}
          </div>
        </div>
      ))}
    </div>
  )
}
