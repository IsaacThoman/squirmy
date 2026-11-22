import {
  ChangePasswordRequest, ConnectListenBrainzRequest, CreateAppPasswordRequest, UpdateUserRequest,
  type AppPassword, type NormalizationMode, type ScrobbleService, type ScrobbleTarget, type ScrobblingStatus, type StreamQuality, type UpdateUserSettings, type User, type UserSettings,
} from '@squirmy/contracts'
import { AlertTriangle, AudioLines, Info, KeyRound, LogOut, Palette, Pencil, Plus, Radio, ShieldCheck, User as UserIcon, type LucideIcon } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useFormSubmit } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter, DialogFrame, DialogTitle } from '@/components/ui/dialog'
import { Badge, Kbd, Separator, Skeleton } from '@/components/ui/feedback'
import { Field, FormError, Input } from '@/components/ui/input'
import { Row } from '@/components/ui/section'
import { Select, type SelectOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatDate, formatRelative } from '@/lib/format'
import { modKey } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { AppearanceSettings } from './AppearanceSettings'
import type { SettingsSection } from './settings-dialog'

const sections: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: 'playback', label: 'Playback', icon: AudioLines },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'account', label: 'Account', icon: UserIcon },
  { id: 'scrobbling', label: 'Scrobbling', icon: Radio },
  { id: 'app-passwords', label: 'App passwords', icon: KeyRound },
  { id: 'about', label: 'About', icon: Info },
]

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

const shortcuts: { keys: string[]; action: string }[] = [
  { keys: ['Space'], action: 'Play or pause' },
  { keys: ['←', '→'], action: 'Seek 5 seconds' },
  { keys: ['↑', '↓'], action: 'Volume' },
  { keys: [`${modKey}K`], action: 'Search' },
  { keys: [`${modKey}B`], action: 'Show or hide the sidebar' },
  { keys: [`${modKey},`], action: 'Settings' },
]

export type SettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  user: User
  serverName: string
  version: string
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
  /** Sends the browser to Last.fm, which returns to the settings. */
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
  /** Admins get a link to the admin panel under the sections. */
  onOpenAdmin?: () => void
}

/** The user's settings in a dialog: sections down the left, the chosen one on the right. */
export function SettingsDialog({
  open, onOpenChange, section, onSectionChange, user, serverName, version, settings, onSettingsChange, deviceName, defaultDeviceName, onDeviceNameChange,
  scrobbling, onConnectListenBrainz, onConnectLastFm, onDisconnect, appPasswords, onCreateAppPassword, onRevokeAppPassword, onChangePassword, onRename, onLogout, onOpenAdmin,
}: SettingsDialogProps) {
  const [dialog, setDialog] = useState<'app-password' | 'password' | 'rename' | 'listenbrainz' | null>(null)
  const [revoking, setRevoking] = useState<AppPassword | null>(null)
  const [disconnecting, setDisconnecting] = useState<ScrobbleService | null>(null)
  const close = (next: boolean) => { if (!next) setDialog(null) }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogFrame className="flex h-[min(680px,calc(100dvh-2rem))] flex-col overflow-hidden sm:h-[600px] sm:max-h-[85vh] lg:max-w-3xl">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden sm:flex-row">
          <div className="flex w-full shrink-0 flex-col border-b bg-muted/30 p-2 sm:w-52 sm:border-b-0 sm:border-r sm:p-3">
            <DialogTitle className="px-2 pb-1.5 pr-8 text-sm font-semibold sm:pb-2 sm:pr-2">Settings</DialogTitle>
            <nav aria-label="Settings sections" className="scrollbar-none flex gap-1 overflow-x-auto pb-0.5 sm:block sm:space-y-0.5 sm:overflow-visible sm:pb-0">
              {sections.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => onSectionChange(id)}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:w-full sm:gap-2.5',
                    section === id ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-4" />{label}
                </button>
              ))}
            </nav>
            {onOpenAdmin && (
              <div className="mt-auto hidden border-t pt-3 sm:block">
                <button type="button" onClick={onOpenAdmin} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <ShieldCheck aria-hidden className="size-4" />Admin panel
                </button>
              </div>
            )}
          </div>

          <div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6">
            {section === 'playback' && (
              <Panel title="Playback">
                {settings ? (
                  <>
                    <Row htmlFor="normalization" label="Volume normalization" description="Evens out loudness between songs. Automatic uses album levels when you play an album in order.">
                      <Select id="normalization" label="Volume normalization" value={settings.normalization} options={normalizationOptions} onValueChange={normalization => onSettingsChange({ normalization })} className="w-40" />
                    </Row>
                    <Row htmlFor="quality-wifi" label="Streaming quality" description="On Wi-Fi and in the browser. Original plays the file untouched when your device supports it.">
                      <Select id="quality-wifi" label="Streaming quality" value={settings.qualityWifi} options={qualityOptions} onValueChange={qualityWifi => onSettingsChange({ qualityWifi })} className="w-40" />
                    </Row>
                    <Row htmlFor="quality-cellular" label="Cellular quality" description="Used by the iOS app away from Wi-Fi.">
                      <Select id="quality-cellular" label="Cellular quality" value={settings.qualityCellular} options={qualityOptions} onValueChange={qualityCellular => onSettingsChange({ qualityCellular })} className="w-40" />
                    </Row>
                  </>
                ) : <LoadingRows rows={3} />}
                <Separator />
                <Row htmlFor="device-name" label="This browser’s name" description="How your other devices list it when you move playback.">
                  <DeviceNameField key={deviceName} name={deviceName} placeholder={defaultDeviceName} onChange={onDeviceNameChange} />
                </Row>
              </Panel>
            )}

            {section === 'appearance' && <Panel title="Appearance"><AppearanceSettings /></Panel>}

            {section === 'account' && (
              <Panel title="Account">
                <Row
                  label={<span className="flex items-center gap-2">{user.displayName ?? user.username}<Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role === 'admin' ? 'Admin' : 'Member'}</Badge></span>}
                  description={`@${user.username} · joined ${formatDate(user.createdAt)}`}
                >
                  {onRename && <Button size="sm" variant="outline" onClick={() => setDialog('rename')}><Pencil />Edit name</Button>}
                </Row>
                <Row label="Password" description="Changing it signs you out everywhere else.">
                  <Button size="sm" variant="outline" onClick={() => setDialog('password')}>Change password</Button>
                </Row>
                <Separator />
                <Row label="Sign out of this browser">
                  <Button size="sm" variant="outline" onClick={onLogout}><LogOut />Log out</Button>
                </Row>
              </Panel>
            )}

            {section === 'scrobbling' && (
              <Panel title="Scrobbling" description="Send what you listen to to other services. Songs count once you have heard half of them, or four minutes.">
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
              </Panel>
            )}

            {section === 'app-passwords' && (
              <Panel
                title="App passwords"
                description="For Subsonic apps, which need a password of their own. Revoke one to sign that app out."
                action={<Button size="sm" variant="outline" onClick={() => setDialog('app-password')}><Plus />Create</Button>}
              >
                {!appPasswords && <LoadingRows rows={1} />}
                {appPasswords?.length === 0 && <Row label="No app passwords" description="Create one to connect a Subsonic client." />}
                {appPasswords?.map(password => (
                  <Row
                    key={password.id}
                    label={<span className="flex items-center gap-2"><KeyRound className="size-4 text-muted-foreground" />{password.name}</span>}
                    description={`Created ${formatDate(password.createdAt)} · ${password.lastUsedAt ? `last used ${formatRelative(password.lastUsedAt)}` : 'never used'}`}
                  >
                    <Button size="sm" variant="outline" onClick={() => setRevoking(password)}>Revoke</Button>
                  </Row>
                ))}
              </Panel>
            )}

            {section === 'about' && (
              <Panel title="About">
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Server</dt><dd className="truncate">{serverName}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Version</dt><dd className="font-mono text-xs">Squirmy {version}</dd></div>
                  <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Address</dt><dd className="truncate font-mono text-xs">{window.location.origin}</dd></div>
                </dl>
                <Separator />
                <div>
                  <h3 className="text-sm font-medium">Keyboard shortcuts</h3>
                  <dl className="mt-2 space-y-1.5 text-sm">
                    {shortcuts.map(shortcut => (
                      <div key={shortcut.action} className="flex items-center justify-between gap-4">
                        <dt className="text-muted-foreground">{shortcut.action}</dt>
                        <dd className="flex gap-1">{shortcut.keys.map(key => <Kbd key={key} className="text-[11px]">{key}</Kbd>)}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </Panel>
            )}
          </div>
        </div>

        <CreateAppPasswordDialog open={dialog === 'app-password'} onOpenChange={close} onCreate={onCreateAppPassword} />
        <ChangePasswordDialog open={dialog === 'password'} onOpenChange={close} onChange={onChangePassword} />
        {onRename && <RenameDialog key={user.displayName ?? ''} open={dialog === 'rename'} onOpenChange={close} current={user.displayName} onRename={onRename} />}
        <ListenBrainzDialog open={dialog === 'listenbrainz'} onOpenChange={close} onConnect={onConnectListenBrainz} />
        <ConfirmDialog
          open={!!disconnecting}
          onOpenChange={next => { if (!next) setDisconnecting(null) }}
          title={`Disconnect ${disconnecting ? serviceNames[disconnecting.target] : ''}?`}
          description="Songs you play from now on are not sent. Plays still waiting to be sent are dropped."
          confirmLabel="Disconnect"
          onConfirm={() => onDisconnect(disconnecting!.target)}
        />
        <ConfirmDialog
          open={!!revoking}
          onOpenChange={next => { if (!next) setRevoking(null) }}
          title={`Revoke “${revoking?.name}”?`}
          description="Apps using it are signed out and need a new app password."
          confirmLabel="Revoke"
          onConfirm={() => onRevokeAppPassword(revoking!.id)}
        />
      </DialogFrame>
    </Dialog>
  )
}

/** One section of the dialog: its title, then its rows. */
function Panel({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-4 pr-6">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <Separator className="my-3" />
      <div className="flex flex-col gap-4">{children}</div>
    </div>
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
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
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
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
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
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" pending={form.pending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function LoadingRows({ rows }: { rows: number }) {
  return Array.from({ length: rows }, (_, row) => (
    <Row key={row} label={<Skeleton className="h-5 w-40" />} description={<Skeleton className="mt-1 h-4 w-64 max-w-full" />} />
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
    <form onSubmit={event => { event.preventDefault(); save() }} className="w-full @xl:w-56">
      <Input id="device-name" value={value} placeholder={placeholder} maxLength={60} onChange={event => setValue(event.target.value)} onBlur={save} />
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
    <Row
      label={name}
      description={(
        <>
          {scrobbleStatus(service)}
          {service.connected && problem && (
            <span className="mt-1 flex items-start gap-1.5 text-destructive"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{problem}</span>
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
    </Row>
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
        description={<>Paste the user token from <a href="https://listenbrainz.org/settings/" target="_blank" rel="noreferrer" className="font-medium text-primary underline-offset-4 hover:underline">your ListenBrainz settings</a>.</>}
      >
        <form onSubmit={event => void submit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="User token" htmlFor="listenbrainz-token" error={form.errors.token}>
            <Input id="listenbrainz-token" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!form.errors.token} autoFocus />
          </Field>
          <FormError message={form.errors.form} />
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" pending={form.pending} disabled={!token.trim()}>Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
