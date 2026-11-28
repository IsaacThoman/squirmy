import { UpdateServerSettings, type LibraryRoot, type ServerSettings, type SsoTestResult } from '@squirmy/contracts'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Badge, Skeleton } from '@/components/ui/feedback'
import { errorMessage } from '@/api/errors'
import { Field, FormError, Input } from '@/components/ui/input'
import { Row, Section } from '@/components/ui/section'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { inGigabytes } from '@/lib/format'
import { AdminHeader } from './AdminLayout'
import { DraftField, SaveStatus, type SavePatch, type SaveState } from './DraftField'
import { SettingRow } from './Panel'

type Save = SavePatch<UpdateServerSettings>
type Toggle = 'musicBrainzEnabled' | 'coverArtArchiveEnabled' | 'deezerEnabled' | 'wikidataEnabled' | 'lrclibEnabled' | 'registrationRequiresInvite' | 'wantlistEnabled' | 'sonicAnalysisEnabled'
  | 'ssoEnabled' | 'ssoAutoCreateUsers' | 'passwordLoginDisabled'
type Secret = 'listenBrainz' | 'acoustId' | 'fanart' | 'lastFm' | 'sso'

type ServerSettingsProps = {
  /** Undefined while loading. */
  settings: ServerSettings | undefined
  /** Said in place of the form when the settings did not load. */
  failure?: ReactNode
  /** The managed library folders imports can go to. */
  managedRoots: LibraryRoot[] | undefined
  onSave: Save
  status: SaveState
  /** Loads the provider's discovery document with the saved settings. */
  onTestSso: () => Promise<SsoTestResult>
}

/** The import folder setting's "nothing chosen" choice; a select cannot hold null. */
const ONLY_ROOT = 'only'

/** Every operator setting. Each change is saved as soon as it is made; text fields save when they lose focus. */
export function ServerSettingsAdmin({ settings, failure, managedRoots, onSave, status, onTestSso }: ServerSettingsProps) {
  const [editing, setEditing] = useState<Secret | null>(null)
  if (!settings) return failure ? <div><AdminHeader title="Server settings" description="Changes apply right away." />{failure}</div> : <SettingsSkeleton />
  const toggle = (key: Toggle, label: string, description?: string) => (
    <SettingRow label={label} description={description}>
      {save => <Switch aria-label={label} checked={settings[key]} onCheckedChange={value => void save(() => onSave({ [key]: value }))} />}
    </SettingRow>
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

        <SsoSettings settings={settings} onSave={onSave} onTest={onTestSso} secret={secret('sso', settings.ssoClientSecretSet, 'Client secret', 'From the provider, for a confidential client. Stored encrypted.')} toggle={toggle} />

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
          {toggle('sonicAnalysisEnabled', 'Sonic analysis', 'Listens to every song for its tempo, key, energy and sound, so radio keeps a consistent feel. Runs in the background, one song at a time. Off stops new analysis and keeps what was measured.')}
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

/** OpenID Connect: the provider, who may come in, and whether passwords still work. */
function SsoSettings({ settings, onSave, onTest, secret, toggle }: {
  settings: ServerSettings
  onSave: Save
  onTest: () => Promise<SsoTestResult>
  secret: ReactNode
  toggle: (key: Toggle, label: string, description?: string) => ReactNode
}) {
  const [test, setTest] = useState<{ pending: boolean; result?: SsoTestResult; error?: string }>({ pending: false })
  const runTest = async () => {
    setTest({ pending: true })
    try {
      setTest({ pending: false, result: await onTest() })
    } catch (failure) {
      setTest({ pending: false, error: errorMessage(failure) })
    }
  }
  const text = (id: string, field: 'ssoName' | 'ssoIssuerUrl' | 'ssoClientId' | 'ssoScopes' | 'ssoUsernameClaim' | 'ssoGroupsClaim' | 'ssoAllowedGroups', label: string, description: string, nullable = false) => (
    <Row htmlFor={id} label={label} description={description}>
      <DraftField
        id={id} field={field} value={settings[field]} schema={UpdateServerSettings} onSave={onSave} placeholder={nullable ? 'Not set' : undefined}
        className="w-64 max-w-full font-mono md:text-xs" parse={nullable ? (value => value.trim() || null) : undefined}
      />
    </Row>
  )
  const result = test.result
  return (
    <Section title="Single sign-on" description="Let people sign in with an OpenID Connect provider such as Authelia, Authentik, Keycloak or Google. Register Squirmy there as a confidential client with this callback address.">
      <Row label="Callback address" description={settings.ssoCallbackUrl ? 'Give this to the provider as the redirect URI.' : 'Set PUBLIC_URL on the server first: the provider sends people back to it.'}>
        {settings.ssoCallbackUrl && <div className="w-80 max-w-full"><CopyField value={settings.ssoCallbackUrl} label="Callback address" /></div>}
      </Row>
      {text('sso-issuer', 'ssoIssuerUrl', 'Issuer URL', 'The provider’s address, where /.well-known/openid-configuration is found.', true)}
      {text('sso-client', 'ssoClientId', 'Client ID', 'From the provider.', true)}
      {secret}
      {text('sso-name', 'ssoName', 'Button name', 'Shown as “Sign in with …”.')}
      {text('sso-scopes', 'ssoScopes', 'Scopes', 'Must include openid. Add groups if your provider needs it to send them.')}
      {text('sso-username', 'ssoUsernameClaim', 'Username claim', 'Where a new account’s username comes from. An email address gives the part before the @.')}
      {text('sso-groups-claim', 'ssoGroupsClaim', 'Groups claim', 'The claim listing someone’s groups. A dotted path reaches into nested claims, such as realm_access.roles.')}
      {text('sso-groups', 'ssoAllowedGroups', 'Allowed groups', 'Only people in one of these groups (separated by commas) may sign in. Empty lets in everyone the provider accepts.')}
      {toggle('ssoAutoCreateUsers', 'Create accounts', 'Makes a member account for someone the provider accepts who has none here. Off, an admin adds people first; an account with the same verified email address is connected on its own.')}
      <Row
        label="Test the provider"
        description={result
          ? <span role="status" className={result.ok ? 'text-foreground' : 'text-destructive'}>{result.message}</span>
          : test.error ? <span role="status" className="text-destructive">{test.error}</span> : 'Loads the provider’s configuration with the saved settings.'}
      >
        <Button size="sm" variant="outline" pending={test.pending} onClick={() => void runTest()}>Test</Button>
      </Row>
      {toggle('ssoEnabled', 'Offer single sign-on', 'Shows “Sign in with …” on the sign-in page and lets people connect their accounts in their settings.')}
      {toggle('passwordLoginDisabled', 'Turn off password sign-in', 'Sign-in offers only single sign-on and passkeys, and joining with an invite is off. App passwords for Subsonic apps keep working. Needs single sign-on connected to your own account. If it breaks, set SQUIRMY_ADMIN_PASSWORD_LOGIN=true on the server to let admins in with their password.')}
    </Section>
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
      <SettingRow
        label="Import into"
        description={managedRoots && roots.length === 0
          ? <>No folder is managed yet. Make one in <Link to="/admin/library" className="text-primary underline-offset-4 hover:underline">Library</Link>.</>
          : 'With several managed folders, imports wait until one is chosen.'}
      >
        {save => roots.length > 0 && (
          <Select label="Import into" className="w-64 max-w-full" value={chosen ?? ONLY_ROOT} options={options} onValueChange={value => void save(() => onSave({ importRootId: value === ONLY_ROOT ? null : value }))} />
        )}
      </SettingRow>
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
    <SettingRow label="Accept matches automatically above" description="Lower matches wait in the review queue.">
      {save => (
        <div className="flex w-64 max-w-full items-center gap-3">
          <Slider
            label="Automatic match threshold" value={percent} max={100} step={1} valueText={`${percent}%`}
            onValueChange={setDragging}
            onValueCommit={next => void save(() => onSave({ matchAutoAcceptScore: next / 100 })).then(() => setDragging(null))}
          />
          <span className="w-10 text-right text-sm tabular">{percent}%</span>
        </div>
      )}
    </SettingRow>
  )
}

const secrets: Record<Secret, { title: string; description: string; fields: { key: 'listenBrainzToken' | 'acoustIdKey' | 'fanartKey' | 'lastFmKey' | 'lastFmSecret' | 'ssoClientSecret'; label: string }[] }> = {
  sso: { title: 'Client secret', description: 'The secret the provider gave Squirmy’s client.', fields: [{ key: 'ssoClientSecret', label: 'Client secret' }] },
  listenBrainz: { title: 'ListenBrainz token', description: 'A user token from your ListenBrainz profile settings. The server uses it only to look up popularity and similar artists; it scrobbles nothing.', fields: [{ key: 'listenBrainzToken', label: 'User token' }] },
  acoustId: { title: 'AcoustID key', description: 'An application key from acoustid.org.', fields: [{ key: 'acoustIdKey', label: 'API key' }] },
  fanart: { title: 'fanart.tv key', description: 'A personal or project key from fanart.tv.', fields: [{ key: 'fanartKey', label: 'API key' }] },
  lastFm: { title: 'Last.fm API account', description: 'The key and shared secret of a Last.fm API account.', fields: [{ key: 'lastFmKey', label: 'API key' }, { key: 'lastFmSecret', label: 'Shared secret' }] },
}

function secretSet(settings: ServerSettings, secret: Secret): boolean {
  return { listenBrainz: settings.listenBrainzTokenSet, acoustId: settings.acoustIdKeySet, fanart: settings.fanartKeySet, lastFm: settings.lastFmKeySet, sso: settings.ssoClientSecretSet }[secret]
}

/** Write-only: the dialog never sees the stored value, only whether there is one. */
function SecretDialog({ secret, isSet, onOpenChange, onSave }: { secret: Secret; isSet: boolean; onOpenChange: (open: boolean) => void; onSave: Save }) {
  const { title, description, fields } = secrets[secret]
  const [values, setValues] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string>()
  const complete = fields.every(field => values[field.key]?.trim())
  const run = async (kind: 'save' | 'remove') => {
    setPending(kind)
    setError(undefined)
    try {
      await onSave(Object.fromEntries(fields.map(field => [field.key, kind === 'save' ? values[field.key].trim() : null])))
      onOpenChange(false)
    } catch (failure) {
      // Said above the buttons; the dialog stays open to try again.
      setError(errorMessage(failure))
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
          <FormError message={error} />
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
