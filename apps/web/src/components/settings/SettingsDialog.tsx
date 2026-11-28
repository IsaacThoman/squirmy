import {
  ApiTokenScope, ChangePasswordRequest, ConnectListenBrainzRequest, CreateAppPasswordRequest, UpdateUserRequest,
  type AppPassword, type NormalizationMode, type ScrobbleService, type ScrobbleTarget, type ScrobblingStatus, type StreamQuality, type UpdateUserSettings, type User, type UserSettings,
} from '@squirmy/contracts'
import { AlertTriangle, AudioLines, Check, CircleCheck, FolderUp, Info, KeyRound, Library, LogOut, Palette, Pencil, Plus, Radio, Webhook, ShieldCheck, User as UserIcon, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
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
import { WebhookSettings } from '../integrations/WebhookSettings'
import { AppearanceSettings } from './AppearanceSettings'
import type { SettingsSection } from './settings-dialog'

const sections: { id: SettingsSection; label: string; icon: LucideIcon }[] = [
  { id: 'playback', label: 'Playback', icon: AudioLines },
  { id: 'library', label: 'Library', icon: Library },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'account', label: 'Account', icon: UserIcon },
  { id: 'scrobbling', label: 'Scrobbling', icon: Radio },
  { id: 'app-passwords', label: 'App passwords', icon: KeyRound },
  { id: 'webhooks', label: 'Webhooks', icon: Webhook },
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
  { keys: [`${modKey}K`], action: 'Search and commands' },
  { keys: [`${modKey}B`], action: 'Show or hide the sidebar' },
  { keys: [`${modKey},`], action: 'Settings' },
  { keys: ['?'], action: 'All shortcuts' },
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
  onConnectListenBrainz: (token: string, apiUrl?: string) => Promise<unknown>
  /** Sends the browser to Last.fm, which returns to the settings. */
  onConnectLastFm: () => void
  onDisconnect: (target: ScrobbleTarget) => Promise<unknown>
  /** Undefined while loading. */
  appPasswords: AppPassword[] | undefined
  /** Resolves with the new password, whose `secret` is shown once. */
  onCreateAppPassword: (request: CreateAppPasswordRequest) => Promise<AppPassword>
  onRevokeAppPassword: (id: string) => Promise<unknown>
  onChangePassword: (request: ChangePasswordRequest) => Promise<unknown>
  /** Only where the server lets this user rename themselves. */
  onRename?: (displayName: string | null) => Promise<unknown>
  onLogout: () => void
  /** Admins get a link to the admin panel under the sections. */
  onOpenAdmin?: () => void
  /** Whoever may upload gets a link to Your uploads in the Library section. */
  onOpenUploads?: () => void
  /** Said in place of a section's controls when its first read failed. */
  failures?: Partial<Record<'settings' | 'sharing' | 'scrobbling' | 'appPasswords', ReactNode>>
  /** A change the section's controls made that the server refused, said under them. */
  errors?: Partial<Record<'playback' | 'library' | 'scrobbling', string>>
  /** What Last.fm answered when it sent the browser back here, said at the top of Scrobbling. */
  lastFm?: { message: string; ok: boolean }
  /** The password was changed while the dialog is open: the Account section says so. */
  passwordChanged?: boolean
}

/** How long "Saved" stays beside a field that saves as it is left. */
const SAVED_MS = 2500

/** The user's settings in a dialog: sections down the left, the chosen one on the right. */
export function SettingsDialog({
  open, onOpenChange, section, onSectionChange, user, serverName, version, settings, onSettingsChange, deviceName, defaultDeviceName, onDeviceNameChange,
  scrobbling, onConnectListenBrainz, onConnectLastFm, onDisconnect, appPasswords, onCreateAppPassword, onRevokeAppPassword, onChangePassword, onRename, onLogout, onOpenAdmin, onOpenUploads, failures,
  errors, lastFm, passwordChanged,
}: SettingsDialogProps) {
  // The field shows the new name; "Saved" beside it says it reached the device lists.
  const [nameSaved, setNameSaved] = useState(false)
  useEffect(() => {
    if (!nameSaved) return
    const timer = setTimeout(() => setNameSaved(false), SAVED_MS)
    return () => clearTimeout(timer)
  }, [nameSaved])
  const [dialog, setDialog] = useState<'app-password' | 'password' | 'rename' | 'listenbrainz' | null>(null)
  const [revoking, setRevoking] = useState<AppPassword | null>(null)
  const [disconnecting, setDisconnecting] = useState<ScrobbleService | null>(null)
  const close = (next: boolean) => { if (!next) setDialog(null) }
  const nav = useRef<HTMLElement>(null)
  const currentSection = () => nav.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogFrame
        // Focus starts on the section that shows, not the first in the list.
        onOpenAutoFocus={event => {
          const button = currentSection()
          if (!button) return
          event.preventDefault()
          button.focus()
        }}
        className="flex h-[min(680px,calc(100dvh-var(--dialog-inset-y)*2))] flex-col overflow-hidden sm:h-[600px] sm:max-h-[85vh] lg:max-w-3xl"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden sm:flex-row">
          <div className="flex w-full shrink-0 flex-col border-b bg-muted/30 p-2 sm:w-52 sm:border-b-0 sm:border-r sm:p-3">
            <DialogTitle className="px-2 pb-1.5 pr-8 text-sm font-semibold sm:pb-2 sm:pr-2">Settings</DialogTitle>
            {/*
              On a phone the sections are a grid of small tiles, every one in sight: a row that
              scrolled sideways hid half of them with nothing to say they were there. They start a little
              lower than the title, clear of the dialog's Close, whose 44 px reaches below its box on touch.
            */}
            <nav ref={nav} aria-label="Settings sections" className="mt-3 grid grid-cols-3 gap-1 sm:mt-0 sm:block sm:space-y-0.5">
              {sections.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-current={section === id ? 'page' : undefined}
                  onClick={() => onSectionChange(id)}
                  className={cn(
                    'relative flex min-h-11 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:min-h-0 sm:w-full sm:flex-row sm:justify-start sm:gap-2.5 sm:px-2.5 sm:py-2 sm:text-sm sm:pointer-coarse:min-h-11',
                    // The selected fill is close to the panel behind it, so the section that shows also gets
                    // the sidebar's marker: a bar in the action color (under a phone's tile, beside a row) and its icon in that color.
                    'before:absolute before:rounded-full before:bg-primary before:opacity-0 before:inset-x-4 before:bottom-0.5 before:h-[3px] sm:before:inset-x-auto sm:before:bottom-auto sm:before:inset-y-2 sm:before:left-0 sm:before:h-auto sm:before:w-[3px]',
                    section === id ? 'bg-accent font-medium before:opacity-100 [&_svg]:text-primary' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-4 shrink-0" /><span className="max-w-full truncate">{label}</span>
                </button>
              ))}
            </nav>
            {onOpenAdmin && (
              <div className="mt-auto hidden border-t pt-3 sm:block">
                <button type="button" onClick={onOpenAdmin} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 pointer-coarse:min-h-11 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
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
                ) : failures?.settings ?? <LoadingRows rows={3} />}
                <FormError message={errors?.playback} />
                <Separator />
                <Row htmlFor="device-name" label="This browser’s name" description="How your other devices list it when you move playback.">
                  <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
                    {nameSaved && <><Check aria-hidden className="size-3.5 text-primary" />Saved</>}
                  </span>
                  <DeviceNameField
                    key={deviceName}
                    name={deviceName}
                    placeholder={defaultDeviceName}
                    onChange={next => {
                      onDeviceNameChange(next)
                      setNameSaved(true)
                    }}
                  />
                </Row>
              </Panel>
            )}

            {section === 'library' && (
              <Panel title="Library" description="Your library is what you heart, with the music you upload. Everything on this server is on Home, and plays for everyone.">
                {settings ? (
                  <>
                    <Row
                      htmlFor="library-server-music"
                      label="Show all of this server’s music in your library"
                      description="Adds every album on this server to your library, as well as what you heart. Turn it off to keep your library to your own picks."
                    >
                      <Switch
                        id="library-server-music"
                        checked={settings.libraryIncludesServerMusic}
                        onCheckedChange={libraryIncludesServerMusic => onSettingsChange({ libraryIncludesServerMusic })}
                      />
                    </Row>
                    <Row
                      htmlFor="library-ratings"
                      label="Show star ratings"
                      description="Rate songs from one to five stars in their menus, and use ratings in smart playlists. The heart still decides what is in your library."
                    >
                      <Switch id="library-ratings" checked={settings.showRatings} onCheckedChange={showRatings => onSettingsChange({ showRatings })} />
                    </Row>
                    <Row
                      htmlFor="allow-explicit"
                      label="Allow explicit content"
                      description={user.explicitRestricted
                        ? 'An admin turned explicit content off for your account. Ask them to turn it back on.'
                        : 'Turn it off to gray out songs marked explicit and keep them out of search, radio and your queue. A clean version plays instead when there is one.'}
                    >
                      <Switch
                        id="allow-explicit"
                        checked={settings.allowExplicit && !user.explicitRestricted}
                        disabled={user.explicitRestricted}
                        onCheckedChange={allowExplicit => onSettingsChange({ allowExplicit })}
                      />
                    </Row>
                  </>
                ) : failures?.settings ?? <LoadingRows rows={2} />}
                <FormError message={errors?.library} />
                {onOpenUploads && (
                  <>
                    <Separator />
                    <Row label="Your uploads" description="See and delete the music you uploaded to this server.">
                      <Button size="sm" variant="outline" onClick={onOpenUploads}><FolderUp />Manage</Button>
                    </Row>
                  </>
                )}
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
                <Row
                  label="Password"
                  description={passwordChanged
                    ? <span role="status" className="flex items-center gap-1.5 text-foreground"><CircleCheck aria-hidden className="size-3.5 shrink-0 text-primary" />Password changed. Your other sessions were signed out.</span>
                    : 'Changing it signs you out everywhere else.'}
                >
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
                {settings ? (
                  <Row
                    htmlFor="share-now-playing"
                    label="Share what I’m listening to with other users on this server"
                    description="Lets other users see your current song in Subsonic apps."
                  >
                    <Switch
                      id="share-now-playing"
                      checked={settings.shareNowPlaying ?? false}
                      onCheckedChange={shareNowPlaying => onSettingsChange({ shareNowPlaying })}
                    />
                  </Row>
                ) : failures?.sharing ?? <LoadingRows rows={1} />}
                <Separator />
                {lastFm && (
                  <p role="status" className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', lastFm.ok ? 'border-primary/30 bg-primary/10' : 'border-destructive/30 bg-destructive/10 text-destructive')}>
                    {lastFm.ok ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" /> : <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />}
                    {lastFm.message}
                  </p>
                )}
                {scrobbling
                  ? scrobbling.services.map(service => (
                    <ScrobbleRow
                      key={service.target}
                      service={service}
                      onToggle={enabled => onSettingsChange(service.target === 'listenbrainz' ? { scrobbleListenBrainz: enabled } : { scrobbleLastFm: enabled })}
                      onConnect={service.target === 'listenbrainz' ? () => setDialog('listenbrainz') : onConnectLastFm}
                      onDisconnect={() => setDisconnecting(service)}
                      syncHearts={service.target === 'listenbrainz' ? settings?.syncListenBrainzHearts : settings?.syncLastFmHearts}
                      onSyncHearts={enabled => onSettingsChange(service.target === 'listenbrainz' ? { syncListenBrainzHearts: enabled } : { syncLastFmHearts: enabled })}
                    />
                  ))
                  : failures?.scrobbling ?? <LoadingRows rows={2} />}
                <FormError message={errors?.scrobbling} />
              </Panel>
            )}

            {section === 'app-passwords' && (
              <Panel
                title="App passwords"
                description="Create credentials for Subsonic clients and scoped tokens for the Squirmy API."
                action={<Button size="sm" variant="outline" onClick={() => setDialog('app-password')}><Plus />Create</Button>}
              >
                {!appPasswords && (failures?.appPasswords ?? <LoadingRows rows={1} />)}
                {appPasswords?.length === 0 && <Row label="No app passwords" description="Create one to connect a Subsonic client." />}
                {appPasswords?.map(password => (
                  <Row
                    key={password.id}
                    label={<span className="flex items-center gap-2"><KeyRound className="size-4 text-muted-foreground" />{password.name}</span>}
                    description={`${password.scopes ? password.scopes.map(scope => scopeLabels[scope]).join(', ') : 'Subsonic'}${password.expiresAt ? ` · Expires ${formatDate(password.expiresAt)}` : ''} · Created ${formatDate(password.createdAt)} · ${password.lastUsedAt ? `last used ${formatRelative(password.lastUsedAt)}` : 'never used'}`}
                  >
                    <Button size="sm" variant="outline" onClick={() => setRevoking(password)}>Revoke</Button>
                  </Row>
                ))}
              </Panel>
            )}

            {section === 'webhooks' && <WebhookSettings />}

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

        <CreateAppPasswordDialog open={dialog === 'app-password'} onOpenChange={close} onCreate={onCreateAppPassword} admin={user.role === 'admin'} />
        <ChangePasswordDialog open={dialog === 'password'} onOpenChange={close} onChange={onChangePassword} />
        {onRename && <RenameDialog key={user.displayName ?? ''} open={dialog === 'rename'} onOpenChange={close} current={user.displayName} onRename={onRename} />}
        <ListenBrainzDialog open={dialog === 'listenbrainz'} onOpenChange={close} onConnect={onConnectListenBrainz} currentUrl={scrobbling?.services.find(service => service.target === 'listenbrainz')?.apiUrl} />
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

const scopeLabels: Record<ApiTokenScope, string> = {
  'library:read': 'Read library', 'playback:control': 'Control playback', 'playlists:manage': 'Manage playlists', admin: 'Admin',
}

function CreateAppPasswordDialog({ open, onOpenChange, onCreate, admin }: { admin: boolean; open: boolean; onOpenChange: (open: boolean) => void; onCreate: (request: CreateAppPasswordRequest) => Promise<AppPassword> }) {
  const [name, setName] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [created, setCreated] = useState<AppPassword | null>(null)
  const [scoped, setScoped] = useState(false)
  const [scopes, setScopes] = useState<ApiTokenScope[]>([])
  const [expiry, setExpiry] = useState('')
  const form = useFormSubmit(CreateAppPasswordRequest, async (request) => setCreated(await onCreate(request)), { invalid_credentials: 'currentPassword' })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void form.submit({ name, currentPassword, ...(scoped && { scopes, ...(expiry && { expiresAt: new Date(expiry).toISOString() }) }) })
  }
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setName('')
      setCurrentPassword('')
      setCreated(null)
      setScoped(false)
      setScopes([])
      setExpiry('')
      form.reset()
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={created ? (scoped ? 'Copy your API token' : 'Copy your app password') : (scoped ? 'New API token' : 'New app password')} description={created ? (scoped ? 'Send this token as a Bearer credential. It is shown once.' : 'This is the only time it is shown. Paste it into your Subsonic app with your username.') : 'Name it after the app that will use it.'}>
        {created ? (
          <div className="flex flex-col gap-4">
            <CopyField value={created.secret ?? ''} label={scoped ? "API token" : "App password"} />
            <DialogFooter><DialogClose asChild><Button>Done</Button></DialogClose></DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
            <Field label="Name" htmlFor="app-password-name" error={form.errors.name}>
              <Input id="app-password-name" value={name} onChange={event => setName(event.target.value)} placeholder="Car stereo" aria-invalid={!!form.errors.name} autoFocus />
            </Field>
            <label className="flex items-center justify-between gap-4 text-sm">
              Scoped API token
              <Switch checked={scoped} onCheckedChange={setScoped} />
            </label>
            {scoped && (
              <fieldset className="space-y-2 text-sm">
                <legend className="mb-2 font-medium">Permissions</legend>
                {ApiTokenScope.options.filter(scope => scope !== 'admin' || admin).map(scope => (
                  <label key={scope} className="flex items-center gap-2">
                    <input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(value => value !== scope))} />
                    {scopeLabels[scope]}
                  </label>
                ))}
                <Field label="Expires (optional)" htmlFor="api-token-expiry" error={form.errors.expiresAt}>
                  <Input id="api-token-expiry" type="date" value={expiry} onChange={event => setExpiry(event.target.value)} />
                </Field>
              </fieldset>
            )}
            <Field label="Your password" htmlFor="app-password-current" error={form.errors.currentPassword}>
              <Input id="app-password-current" type="password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} autoComplete="current-password" aria-invalid={!!form.errors.currentPassword} />
            </Field>
            <FormError message={form.errors.form} />
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button type="submit" variant="primary" pending={form.pending} disabled={!name.trim() || !currentPassword || (scoped && !scopes.length)}>Create</Button>
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
      <DialogContent title="Change password" description="Other browsers and apps signed in with your password are signed out, and your app passwords are deleted: make new ones for your Subsonic apps.">
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
    <form onSubmit={event => { event.preventDefault(); save() }} className="w-full @md:w-56">
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

function ScrobbleRow({ service, onToggle, onConnect, onDisconnect, syncHearts, onSyncHearts }: { syncHearts?: boolean; onSyncHearts: (enabled: boolean) => void; service: ScrobbleService; onToggle: (enabled: boolean) => void; onConnect: () => void; onDisconnect: () => void }) {
  const name = serviceNames[service.target]
  const problem = service.needsAttention ? `${name} no longer accepts this connection. Connect again to keep scrobbling.` : service.lastError
  return (
    <>
    <Row
      label={name}
      description={(
        <>
          {scrobbleStatus(service)}
          {service.apiUrl && <span className="block break-all">{service.apiUrl}</span>}
          {service.connected && problem && (
            <span className="mt-1 flex items-start gap-1.5 text-destructive"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{problem}</span>
          )}
        </>
      )}
    >
      {service.connected ? (
        <>
          {(service.needsAttention || service.target === 'listenbrainz') && <Button size="sm" variant="outline" onClick={onConnect}>{service.needsAttention ? 'Reconnect' : 'Change connection'}</Button>}
          <Button size="sm" variant="outline" onClick={onDisconnect}>Disconnect</Button>
          <Switch aria-label={`Scrobble to ${name}`} checked={service.enabled} onCheckedChange={onToggle} />
        </>
      ) : (
        <Button size="sm" variant="outline" disabled={!service.available} onClick={onConnect}>Connect</Button>
      )}
    </Row>
    {service.connected && (
      <Row label={`Sync hearts with ${name}`} description="Import feedback and send hearts from Squirmy.">
        <Switch aria-label={`Sync hearts with ${name}`} checked={syncHearts ?? false} onCheckedChange={onSyncHearts} />
      </Row>
    )}
    </>
  )
}

function ListenBrainzDialog({ open, onOpenChange, onConnect, currentUrl }: { open: boolean; onOpenChange: (open: boolean) => void; onConnect: (token: string, apiUrl?: string) => Promise<unknown>; currentUrl?: string }) {
  const [token, setToken] = useState('')
  const [url, setUrl] = useState<string | undefined>()
  const apiUrl = url ?? currentUrl ?? ''
  const form = useFormSubmit(ConnectListenBrainzRequest, ({ token, apiUrl }) => apiUrl ? onConnect(token, apiUrl) : onConnect(token), { invalid_token: 'token', invalid_api_url: 'apiUrl' })
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setToken('')
      setUrl(undefined)
      form.reset()
    }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await form.submit({ token, apiUrl: apiUrl.trim() || undefined })) close(false)
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
          <Field label="API URL (optional)" htmlFor="listenbrainz-api-url" error={form.errors.apiUrl}>
            <Input id="listenbrainz-api-url" type="url" value={apiUrl} onChange={event => setUrl(event.target.value)} placeholder="https://api.listenbrainz.org/1/" />
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
