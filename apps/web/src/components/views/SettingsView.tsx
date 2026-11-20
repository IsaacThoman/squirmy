import {
  ChangePasswordRequest, ConnectListenBrainzRequest, CreateAppPasswordRequest, UpdateUserRequest,
  type AppPassword, type NormalizationMode, type ScrobbleService, type ScrobbleTarget, type ScrobblingStatus, type StreamQuality, type UpdateUserSettings, type User, type UserSettings,
} from '@squirmy/contracts'
import { AlertTriangle, KeyRound, LogOut, Pencil, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useFormSubmit } from '@/api/errors'
import { Page } from '@/components/layout/Page'
import { SettingRow, SettingsSection } from '@/components/layout/Settings'
import { PageTitle } from '@/components/music/SectionHeader'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Badge, Skeleton } from '@/components/ui/feedback'
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, FormError, Input } from '@/components/ui/input'
import { Select, type SelectOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatDate, formatRelative } from '@/lib/format'

const normalizationOptions: SelectOption<NormalizationMode>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'track', label: 'Per song' },
  { value: 'album', label: 'Per album' },
  { value: 'off', label: 'Off' },
]

const qualityOptions: SelectOption<StreamQuality>[] = [
  { value: 'original', label: 'Original' },
  { value: 'high', label: 'High (AAC 256)' },
  { value: 'data_saver', label: 'Data saver' },
]

type SettingsViewProps = {
  user: User
  /** Undefined while loading. */
  settings: UserSettings | undefined
  onSettingsChange: (patch: UpdateUserSettings) => void
  /** This browser's name in device lists, and the one it has without a custom name. */
  deviceName: string
  defaultDeviceName: string
  onDeviceNameChange: (name: string | null) => void
  /** Undefined while loading. */
  scrobbling: ScrobblingStatus | undefined
  onConnectListenBrainz: (token: string) => Promise<unknown>
  /** Sends the browser to Last.fm, which returns to this page. */
  onConnectLastFm: () => void
  onDisconnect: (target: ScrobbleTarget) => Promise<unknown>
  /** Undefined while loading. */
  appPasswords: AppPassword[] | undefined
  /** Resolves with the new password, whose `secret` is shown once. */
  onCreateAppPassword: (name: string) => Promise<AppPassword>
  onRevokeAppPassword: (id: string) => Promise<unknown>
  onChangePassword: (request: ChangePasswordRequest) => Promise<unknown>
  /** Only where the server lets this user rename themselves. */
  onRename?: (displayName: string | null) => Promise<unknown>
  onLogout: () => void
}

export function SettingsView({
  user, settings, onSettingsChange, deviceName, defaultDeviceName, onDeviceNameChange, scrobbling, onConnectListenBrainz, onConnectLastFm, onDisconnect,
  appPasswords, onCreateAppPassword, onRevokeAppPassword, onChangePassword, onRename, onLogout,
}: SettingsViewProps) {
  const [dialog, setDialog] = useState<'app-password' | 'password' | 'rename' | 'listenbrainz' | null>(null)
  const [revoking, setRevoking] = useState<AppPassword | null>(null)
  const [disconnecting, setDisconnecting] = useState<ScrobbleService | null>(null)
  const close = (open: boolean) => { if (!open) setDialog(null) }
  return (
    <Page className="flex max-w-3xl flex-col gap-9">
      <PageTitle>Settings</PageTitle>

      <SettingsSection title="Playback">
        {settings ? (
          <>
            <SettingRow htmlFor="normalization" label="Volume normalization" description="Evens out loudness between songs. Automatic uses album levels when you play an album in order.">
              <Select id="normalization" label="Volume normalization" value={settings.normalization} options={normalizationOptions} onValueChange={normalization => onSettingsChange({ normalization })} />
            </SettingRow>
            <SettingRow htmlFor="quality-wifi" label="Streaming quality" description="On Wi-Fi and in the browser. Original plays the file untouched when your device supports it.">
              <Select id="quality-wifi" label="Streaming quality" value={settings.qualityWifi} options={qualityOptions} onValueChange={qualityWifi => onSettingsChange({ qualityWifi })} />
            </SettingRow>
            <SettingRow htmlFor="quality-cellular" label="Cellular quality" description="Used by the iOS app away from Wi-Fi.">
              <Select id="quality-cellular" label="Cellular quality" value={settings.qualityCellular} options={qualityOptions} onValueChange={qualityCellular => onSettingsChange({ qualityCellular })} />
            </SettingRow>
          </>
        ) : <LoadingRows rows={3} />}
        <SettingRow htmlFor="device-name" label="This browser’s name" description="How your other devices list it when you move playback.">
          <DeviceNameField key={deviceName} name={deviceName} placeholder={defaultDeviceName} onChange={onDeviceNameChange} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Scrobbling" description="Send what you listen to to other services. Songs count once you have heard half of them, or four minutes.">
        {scrobbling
          ? scrobbling.services.map(service => (
            <ScrobbleRow
              key={service.target}
              service={service}
              onToggle={enabled => onSettingsChange(service.target === 'listenbrainz' ? { scrobbleListenBrainz: enabled } : { scrobbleLastFm: enabled })}
              onConnect={service.target === 'listenbrainz' ? () => setDialog('listenbrainz') : onConnectLastFm}
              onDisconnect={() => setDisconnecting(service)}
            />
          ))
          : <LoadingRows rows={2} />}
      </SettingsSection>

      <SettingsSection
        title="App passwords"
        description="For Subsonic apps, which need a password of their own. Revoke one to sign that app out."
        action={<Button size="sm" onClick={() => setDialog('app-password')}><Plus />Create</Button>}
      >
        {!appPasswords && <SettingRow label={<Skeleton className="h-5 w-40" />} description={<Skeleton className="mt-1 h-4 w-56" />} />}
        {appPasswords?.length === 0 && <SettingRow label="No app passwords" description="Create one to connect a Subsonic client." />}
        {appPasswords?.map(password => (
          <SettingRow
            key={password.id}
            label={<span className="flex items-center gap-2"><KeyRound className="size-4 text-quiet" />{password.name}</span>}
            description={`Created ${formatDate(password.createdAt)} · ${password.lastUsedAt ? `last used ${formatRelative(password.lastUsedAt)}` : 'never used'}`}
          >
            <Button size="sm" variant="outline" onClick={() => setRevoking(password)}>Revoke</Button>
          </SettingRow>
        ))}
      </SettingsSection>

      <SettingsSection title="Account">
        <SettingRow label={user.displayName ?? user.username} description={`@${user.username} · joined ${formatDate(user.createdAt)}`}>
          <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role}</Badge>
          {onRename && <Button size="sm" variant="outline" onClick={() => setDialog('rename')}><Pencil />Edit name</Button>}
        </SettingRow>
        <SettingRow label="Password" description="Changing it signs you out everywhere else.">
          <Button size="sm" variant="outline" onClick={() => setDialog('password')}>Change password</Button>
        </SettingRow>
        <SettingRow label="Sign out of this browser">
          <Button size="sm" variant="outline" onClick={onLogout}><LogOut />Log out</Button>
        </SettingRow>
      </SettingsSection>

      <CreateAppPasswordDialog open={dialog === 'app-password'} onOpenChange={close} onCreate={onCreateAppPassword} />
      <ChangePasswordDialog open={dialog === 'password'} onOpenChange={close} onChange={onChangePassword} />
      {onRename && <RenameDialog key={user.displayName ?? ''} open={dialog === 'rename'} onOpenChange={close} current={user.displayName} onRename={onRename} />}
      <ListenBrainzDialog open={dialog === 'listenbrainz'} onOpenChange={close} onConnect={onConnectListenBrainz} />
      <ConfirmDialog
        open={!!disconnecting}
        onOpenChange={open => { if (!open) setDisconnecting(null) }}
        title={`Disconnect ${disconnecting ? serviceNames[disconnecting.target] : ''}?`}
        description="Songs you play from now on are not sent. Plays still waiting to be sent are dropped."
        confirmLabel="Disconnect"
        onConfirm={() => onDisconnect(disconnecting!.target)}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={open => { if (!open) setRevoking(null) }}
        title={`Revoke “${revoking?.name}”?`}
        description="Apps using it are signed out and need a new app password."
        confirmLabel="Revoke"
        onConfirm={() => onRevokeAppPassword(revoking!.id)}
      />
    </Page>
  )
}

function CreateAppPasswordDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: (name: string) => Promise<AppPassword> }) {
  const [name, setName] = useState('')
  const [created, setCreated] = useState<AppPassword | null>(null)
  const form = useFormSubmit(CreateAppPasswordRequest, async ({ name }) => setCreated(await onCreate(name)))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void form.submit({ name })
  }
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setName('')
      setCreated(null)
      form.reset()
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={created ? 'Copy your app password' : 'New app password'} description={created ? 'This is the only time it is shown. Paste it into your Subsonic app with your username.' : 'Name it after the app that will use it.'}>
        {created ? (
          <div className="flex flex-col gap-4">
            <CopyField value={created.secret ?? ''} label="App password" />
            <DialogFooter><DialogClose asChild><Button>Done</Button></DialogClose></DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <Field label="Name" htmlFor="app-password-name" error={form.errors.name}>
              <Input id="app-password-name" value={name} onChange={event => setName(event.target.value)} placeholder="Car stereo" aria-invalid={!!form.errors.name} autoFocus />
            </Field>
            <FormError message={form.errors.form} />
            <DialogFooter>
              <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
              <Button type="submit" variant="primary" pending={form.pending} disabled={!name.trim()}>Create</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

const emptyPasswords = { currentPassword: '', newPassword: '', confirm: '' }

function ChangePasswordDialog({ open, onOpenChange, onChange }: { open: boolean; onOpenChange: (open: boolean) => void; onChange: (request: ChangePasswordRequest) => Promise<unknown> }) {
  const [value, setValue] = useState(emptyPasswords)
  const [mismatch, setMismatch] = useState(false)
  const form = useFormSubmit(ChangePasswordRequest, onChange, { invalid_credentials: 'currentPassword' })
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setValue(emptyPasswords)
      setMismatch(false)
      form.reset()
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const differs = value.confirm !== value.newPassword
    setMismatch(differs)
    if (!differs && await form.submit(value)) close(false)
  }
  const field = (key: keyof typeof emptyPasswords) => ({
    id: `password-${key}`,
    type: 'password',
    value: value[key],
    onChange: (event: { target: { value: string } }) => setValue(current => ({ ...current, [key]: event.target.value })),
  })
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Change password" description="Other browsers and apps signed in with your password are signed out. App passwords keep working.">
        <form onSubmit={event => void submit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="Current password" htmlFor="password-currentPassword" error={form.errors.currentPassword}>
            <Input {...field('currentPassword')} autoComplete="current-password" aria-invalid={!!form.errors.currentPassword} autoFocus />
          </Field>
          <Field label="New password" htmlFor="password-newPassword" error={form.errors.newPassword} hint="At least 8 characters.">
            <Input {...field('newPassword')} autoComplete="new-password" aria-invalid={!!form.errors.newPassword} />
          </Field>
          <Field label="Repeat the new password" htmlFor="password-confirm" error={mismatch ? 'The passwords do not match' : undefined}>
            <Input {...field('confirm')} autoComplete="new-password" aria-invalid={mismatch} />
          </Field>
          <FormError message={form.errors.form} />
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" pending={form.pending}>Change password</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RenameDialog({ open, onOpenChange, current, onRename }: { open: boolean; onOpenChange: (open: boolean) => void; current: string | null; onRename: (displayName: string | null) => Promise<unknown> }) {
  const [name, setName] = useState(current ?? '')
  const form = useFormSubmit(UpdateUserRequest.pick({ displayName: true }), ({ displayName }) => onRename(displayName ?? null))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await form.submit({ displayName: name.trim() || null })) onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={next => { onOpenChange(next); if (!next) setName(current ?? '') }}>
      <DialogContent title="Your name" description="Shown to the other people on this server. Leave it empty to use your username.">
        <form onSubmit={event => void submit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="Display name" htmlFor="display-name" error={form.errors.displayName}>
            <Input id="display-name" value={name} onChange={event => setName(event.target.value)} aria-invalid={!!form.errors.displayName} autoFocus />
          </Field>
          <FormError message={form.errors.form} />
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" pending={form.pending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LoadingRows({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, row) => (
    <SettingRow key={row} label={<Skeleton className="h-5 w-40" />} description={<Skeleton className="mt-1 h-4 w-64 max-w-full" />} />
  ))
}

/** Saves on Enter or when focus leaves; empty goes back to the name from the browser. */
function DeviceNameField({ name, placeholder, onChange }: { name: string; placeholder: string; onChange: (name: string | null) => void }) {
  const [value, setValue] = useState(name === placeholder ? '' : name)
  const save = () => {
    const next = value.trim() || null
    if ((next ?? placeholder) !== name) onChange(next)
  }
  return (
    <form onSubmit={event => { event.preventDefault(); save() }} className="w-full sm:w-64">
      <Input id="device-name" value={value} placeholder={placeholder} maxLength={60} onChange={event => setValue(event.target.value)} onBlur={save} className="h-9 text-sm" />
    </form>
  )
}

const serviceNames: Record<ScrobbleTarget, string> = { listenbrainz: 'ListenBrainz', lastfm: 'Last.fm' }

function scrobbleStatus(service: ScrobbleService): string {
  if (!service.available) return 'An admin of this server has to add a Last.fm API key first.'
  if (!service.connected) return service.target === 'listenbrainz' ? 'Connect with the user token from your ListenBrainz settings.' : 'Connect your Last.fm account.'
  const parts = [`Connected as ${service.account ?? 'you'}`]
  if (service.pending) parts.push(`${service.pending.toLocaleString()} waiting to be sent`)
  if (service.failed) parts.push(`${service.failed.toLocaleString()} could not be sent`)
  return parts.join(' · ')
}

function ScrobbleRow({ service, onToggle, onConnect, onDisconnect }: { service: ScrobbleService; onToggle: (enabled: boolean) => void; onConnect: () => void; onDisconnect: () => void }) {
  const name = serviceNames[service.target]
  const problem = service.needsAttention ? `${name} no longer accepts this connection. Connect again to keep scrobbling.` : service.lastError
  return (
    <SettingRow
      label={name}
      description={(
        <>
          {scrobbleStatus(service)}
          {service.connected && problem && (
            <span className="mt-1 flex items-start gap-1.5 font-medium text-danger"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{problem}</span>
          )}
        </>
      )}
    >
      {service.connected ? (
        <>
          {service.needsAttention && <Button size="sm" variant="primary" onClick={onConnect}>Reconnect</Button>}
          <Button size="sm" variant="outline" onClick={onDisconnect}>Disconnect</Button>
          <Switch aria-label={`Scrobble to ${name}`} checked={service.enabled} onCheckedChange={onToggle} />
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={!service.available} onClick={onConnect}>Connect</Button>
      )}
    </SettingRow>
  )
}

function ListenBrainzDialog({ open, onOpenChange, onConnect }: { open: boolean; onOpenChange: (open: boolean) => void; onConnect: (token: string) => Promise<unknown> }) {
  const [token, setToken] = useState('')
  const form = useFormSubmit(ConnectListenBrainzRequest, ({ token }) => onConnect(token), { invalid_token: 'token' })
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setToken('')
      form.reset()
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await form.submit({ token })) close(false)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title="Connect ListenBrainz"
        description={<>Paste the user token from <a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer" className="font-semibold text-accent hover:underline">your ListenBrainz settings</a>.</>}
      >
        <form onSubmit={event => void submit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="User token" htmlFor="listenbrainz-token" error={form.errors.token}>
            <Input id="listenbrainz-token" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!form.errors.token} autoFocus />
          </Field>
          <FormError message={form.errors.form} />
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" pending={form.pending} disabled={!token.trim()}>Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
