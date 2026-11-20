import type { AppPassword, NormalizationMode, StreamQuality, UpdateUserSettings, User, UserSettings } from '@squirmy/contracts'
import { Check, Copy, KeyRound, LogOut, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Page } from '@/components/layout/Page'
import { SettingRow, SettingsSection } from '@/components/layout/Settings'
import { PageTitle } from '@/components/music/SectionHeader'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/feedback'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
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
  settings: UserSettings
  onSettingsChange: (patch: UpdateUserSettings) => void
  appPasswords: AppPassword[]
  /** Resolves with the new password, whose `secret` is shown once. */
  onCreateAppPassword: (name: string) => AppPassword
  onRevokeAppPassword: (id: string) => void
  onChangePassword: () => void
  onLogout: () => void
}

export function SettingsView({ user, settings, onSettingsChange, appPasswords, onCreateAppPassword, onRevokeAppPassword, onChangePassword, onLogout }: SettingsViewProps) {
  const [creating, setCreating] = useState(false)
  return (
    <Page className="flex max-w-3xl flex-col gap-9">
      <PageTitle>Settings</PageTitle>

      <SettingsSection title="Playback">
        <SettingRow htmlFor="normalization" label="Volume normalization" description="Evens out loudness between songs. Automatic uses album levels when you play an album in order.">
          <Select id="normalization" label="Volume normalization" value={settings.normalization} options={normalizationOptions} onValueChange={normalization => onSettingsChange({ normalization })} />
        </SettingRow>
        <SettingRow htmlFor="quality-wifi" label="Streaming quality" description="On Wi-Fi and in the browser. Original plays the file untouched when your device supports it.">
          <Select id="quality-wifi" label="Streaming quality" value={settings.qualityWifi} options={qualityOptions} onValueChange={qualityWifi => onSettingsChange({ qualityWifi })} />
        </SettingRow>
        <SettingRow htmlFor="quality-cellular" label="Cellular quality" description="Used by the iOS app away from Wi-Fi.">
          <Select id="quality-cellular" label="Cellular quality" value={settings.qualityCellular} options={qualityOptions} onValueChange={qualityCellular => onSettingsChange({ qualityCellular })} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Scrobbling" description="Send what you listen to to other services.">
        <SettingRow label="ListenBrainz">
          <Switch aria-label="Scrobble to ListenBrainz" checked={settings.scrobbleListenBrainz} onCheckedChange={scrobbleListenBrainz => onSettingsChange({ scrobbleListenBrainz })} />
        </SettingRow>
        <SettingRow label="Last.fm">
          <Switch aria-label="Scrobble to Last.fm" checked={settings.scrobbleLastFm} onCheckedChange={scrobbleLastFm => onSettingsChange({ scrobbleLastFm })} />
        </SettingRow>
      </SettingsSection>

      <SettingsSection
        title="App passwords"
        description="For Subsonic apps, which need a password of their own. Revoke one to sign that app out."
        action={<Button size="sm" onClick={() => setCreating(true)}><Plus />Create</Button>}
      >
        {appPasswords.length === 0 && <SettingRow label="No app passwords" description="Create one to connect a Subsonic client." />}
        {appPasswords.map(password => (
          <SettingRow
            key={password.id}
            label={<span className="flex items-center gap-2"><KeyRound className="size-4 text-quiet" />{password.name}</span>}
            description={`Created ${formatDate(password.createdAt)} · ${password.lastUsedAt ? `last used ${formatRelative(password.lastUsedAt)}` : 'never used'}`}
          >
            <Button size="sm" variant="outline" onClick={() => onRevokeAppPassword(password.id)}>Revoke</Button>
          </SettingRow>
        ))}
      </SettingsSection>

      <SettingsSection title="Account">
        <SettingRow label={user.displayName ?? user.username} description={`@${user.username} · joined ${formatDate(user.createdAt)}`}>
          <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role}</Badge>
        </SettingRow>
        <SettingRow label="Password">
          <Button size="sm" variant="outline" onClick={onChangePassword}>Change password</Button>
        </SettingRow>
        <SettingRow label="Sign out of this browser">
          <Button size="sm" variant="outline" onClick={onLogout}><LogOut />Log out</Button>
        </SettingRow>
      </SettingsSection>

      <CreateAppPasswordDialog open={creating} onOpenChange={setCreating} onCreate={onCreateAppPassword} />
    </Page>
  )
}

function CreateAppPasswordDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: (name: string) => AppPassword }) {
  const [name, setName] = useState('')
  const [created, setCreated] = useState<AppPassword | null>(null)
  const [copied, setCopied] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setCreated(onCreate(name.trim()))
  }
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setName('')
      setCreated(null)
      setCopied(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={created ? 'Copy your app password' : 'New app password'} description={created ? 'This is the only time it is shown. Paste it into your Subsonic app with your username.' : 'Name it after the app that will use it.'}>
        {created ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 rounded-xl bg-surface p-1.5 pl-4">
              <code className="min-w-0 flex-1 truncate font-mono text-[15px] tracking-wide">{created.secret}</code>
              <Button size="sm" variant="primary" onClick={() => { void navigator.clipboard?.writeText(created.secret ?? ''); setCopied(true) }}>
                {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <DialogFooter><DialogClose asChild><Button>Done</Button></DialogClose></DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field label="Name" htmlFor="app-password-name">
              <Input id="app-password-name" value={name} onChange={event => setName(event.target.value)} placeholder="Car stereo" maxLength={60} autoFocus required />
            </Field>
            <DialogFooter>
              <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
              <Button type="submit" variant="primary" disabled={!name.trim()}>Create</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
