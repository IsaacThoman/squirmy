import type { CreateInviteRequest, Invite, ServerSettings, UpdateServerSettings, User, UserRole } from '@squirmy/contracts'
import { Copy, MoreHorizontal, PlugZap, Plus } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { SettingRow, SettingsSection } from '@/components/layout/Settings'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Badge, EmptyState } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Input } from '@/components/ui/input'
import { DropdownMenu } from '@/components/ui/menu'
import { Select } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { formatBytes, formatDate, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader } from './AdminLayout'

type UsersAdminProps = {
  users: User[]
  invites: Invite[]
  currentUserId: string
  onUserAction: (userId: string, action: 'role' | 'toggle' | 'reset') => void
  onCreateInvite: (request: CreateInviteRequest) => void
  onRevokeInvite: (id: string) => void
  onCopyInvite: (invite: Invite) => void
}

export function UsersAdmin({ users, invites, currentUserId, onUserAction, onCreateInvite, onRevokeInvite, onCopyInvite }: UsersAdminProps) {
  const [inviting, setInviting] = useState(false)
  return (
    <div className="flex flex-col gap-9">
      <AdminHeader title="Users & invites" description="Everyone shares one library. Likes, playlists, history and playback are each person’s own.">
        <Button variant="primary" onClick={() => setInviting(true)}><Plus />Invite someone</Button>
      </AdminHeader>

      <SettingsSection title="Users" className="-mt-6">
        {users.map(user => (
          <SettingRow
            key={user.id}
            label={(
              <span className="flex items-center gap-3">
                <span aria-hidden className={cn('flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold', user.role === 'admin' ? 'bg-accent text-on-accent' : 'bg-surface text-muted')}>
                  {(user.displayName ?? user.username).slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className={cn('block truncate', user.disabled && 'text-quiet line-through')}>{user.displayName ?? user.username}</span>
                  <span className="block truncate text-[13px] font-normal text-muted">@{user.username} · joined {formatDate(user.createdAt)}</span>
                </span>
              </span>
            )}
          >
            {user.disabled && <Badge tone="danger">Disabled</Badge>}
            {user.canUpload && <Badge tone="outline">Upload</Badge>}
            {user.canAcquire && <Badge tone="outline">Fetch</Badge>}
            <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'}>{user.role}</Badge>
            <DropdownMenu
              entries={[
                { label: user.role === 'admin' ? 'Make member' : 'Make admin', disabled: user.id === currentUserId, onSelect: () => onUserAction(user.id, 'role') },
                { label: 'Reset password', onSelect: () => onUserAction(user.id, 'reset') },
                { kind: 'separator' },
                { label: user.disabled ? 'Enable account' : 'Disable account', danger: !user.disabled, disabled: user.id === currentUserId, onSelect: () => onUserAction(user.id, 'toggle') },
              ]}
              trigger={<IconButton label={`Manage ${user.username}`} size="sm"><MoreHorizontal /></IconButton>}
            />
          </SettingRow>
        ))}
      </SettingsSection>

      <SettingsSection title="Invites" description="Share a link. Each one works once.">
        {invites.length === 0 && <SettingRow label="No invites" description="Create one to let someone join." />}
        {invites.map(invite => (
          <SettingRow
            key={invite.id}
            label={<code className="font-mono text-[14px] tracking-wide">{invite.code}</code>}
            description={invite.usedBy ? `Used by @${invite.usedBy}` : invite.expiresAt ? `Expires ${formatRelative(invite.expiresAt)}` : 'Never expires'}
          >
            <Badge tone={invite.role === 'admin' ? 'accent' : 'neutral'}>{invite.role}</Badge>
            {!invite.usedBy && (
              <>
                <Button size="sm" variant="outline" onClick={() => onCopyInvite(invite)}><Copy />Copy link</Button>
                <Button size="sm" variant="ghost" onClick={() => onRevokeInvite(invite.id)}>Revoke</Button>
              </>
            )}
          </SettingRow>
        ))}
      </SettingsSection>

      <InviteDialog open={inviting} onOpenChange={setInviting} onCreate={onCreateInvite} />
    </div>
  )
}

function InviteDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: (request: CreateInviteRequest) => void }) {
  const [role, setRole] = useState<UserRole>('member')
  const [canUpload, setCanUpload] = useState(false)
  const [canAcquire, setCanAcquire] = useState(false)
  const [expiry, setExpiry] = useState<'7' | '14' | '30' | 'never'>('14')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onCreate({ role, canUpload, canAcquire, expiresInDays: expiry === 'never' ? null : Number(expiry) })
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Invite someone" description="They choose their own username and password when they open the link.">
        <form onSubmit={submit} className="flex flex-col gap-1">
          <SettingRow label="Role" description="Admins manage folders, users and settings.">
            <Select label="Role" value={role} onValueChange={setRole} options={[{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }]} />
          </SettingRow>
          <SettingRow label="Can upload music"><Switch aria-label="Can upload music" checked={canUpload} onCheckedChange={setCanUpload} /></SettingRow>
          <SettingRow label="Can fetch missing music" description="Through an acquisition provider."><Switch aria-label="Can fetch missing music" checked={canAcquire} onCheckedChange={setCanAcquire} /></SettingRow>
          <SettingRow label="Link expires">
            <Select label="Link expires" value={expiry} onValueChange={setExpiry} options={[{ value: '7', label: 'In 7 days' }, { value: '14', label: 'In 14 days' }, { value: '30', label: 'In 30 days' }, { value: 'never', label: 'Never' }]} />
          </SettingRow>
          <DialogFooter className="pt-3">
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary">Create invite</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The acquisition contracts are not written yet; this is what the providers page shows. */
export type ProviderItem = { id: string; name: string; url: string; enabled: boolean; status: string; formats: string[]; lastCheck: string | null }

export function ProvidersAdmin({ providers, onToggle, onRegister }: { providers: ProviderItem[]; onToggle: (id: string, enabled: boolean) => void; onRegister: () => void }) {
  return (
    <div>
      <AdminHeader title="Providers" description="Separate services that can supply music you don't have. Off by default; nothing is fetched unless a provider is registered and enabled.">
        <Button variant="primary" onClick={onRegister}><Plus />Register provider</Button>
      </AdminHeader>
      {providers.length === 0 && <EmptyState icon={<PlugZap />} title="No providers" description="Register one by URL and shared secret." />}
      <ul className="grid gap-3 xl:grid-cols-2">
        {providers.map(provider => (
          <li key={provider.id} className="flex items-start gap-4 rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
            <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', provider.enabled ? 'bg-selection text-accent' : 'bg-surface text-quiet')}><PlugZap className="size-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-bold">{provider.name}</h3>
                <span className={cn('size-2 rounded-full', provider.status === 'healthy' ? 'bg-accent' : 'bg-stroke')} aria-hidden />
                <span className="text-xs capitalize text-muted">{provider.status}</span>
              </div>
              <p className="truncate font-mono text-xs text-muted">{provider.url}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {provider.formats.map(format => <Badge key={format} tone="outline">{format}</Badge>)}
                {provider.lastCheck && <span className="text-xs text-quiet">checked {formatRelative(provider.lastCheck)}</span>}
              </div>
            </div>
            <Switch aria-label={`Enable ${provider.name}`} checked={provider.enabled} onCheckedChange={enabled => onToggle(provider.id, enabled)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

type ServerSettingsProps = { settings: ServerSettings; onChange: (patch: UpdateServerSettings) => void; onSetSecret: (key: 'listenBrainzToken' | 'acoustIdKey' | 'fanartKey' | 'lastFmKey') => void }

export function ServerSettingsAdmin({ settings, onChange, onSetSecret }: ServerSettingsProps) {
  const toggle = (key: keyof Pick<ServerSettings, 'musicBrainzEnabled' | 'coverArtArchiveEnabled' | 'deezerEnabled' | 'wikidataEnabled' | 'lrclibEnabled' | 'registrationRequiresInvite'>, label: string, description?: string) => (
    <SettingRow label={label} description={description}>
      <Switch aria-label={label} checked={settings[key]} onCheckedChange={value => onChange({ [key]: value })} />
    </SettingRow>
  )
  const secret = (key: Parameters<ServerSettingsProps['onSetSecret']>[0], set: boolean, label: string, description: string) => (
    <SettingRow label={label} description={description}>
      <Badge tone={set ? 'accent' : 'neutral'}>{set ? 'Set' : 'Not set'}</Badge>
      <Button size="sm" variant="outline" onClick={() => onSetSecret(key)}>{set ? 'Replace' : 'Add key'}</Button>
    </SettingRow>
  )
  return (
    <div className="flex flex-col gap-9">
      <AdminHeader title="Server settings" description="Changes apply right away." />
      <SettingsSection title="General" className="-mt-6">
        <SettingRow htmlFor="server-name" label="Server name" description="Shown on the sign-in page and in Subsonic apps.">
          <Input id="server-name" value={settings.serverName} onChange={event => onChange({ serverName: event.target.value })} className="h-9 w-48" />
        </SettingRow>
        {toggle('registrationRequiresInvite', 'Require an invite to join')}
      </SettingsSection>
      <SettingsSection title="Metadata sources" description="Every source is optional. Turning one off keeps what it already provided.">
        {toggle('musicBrainzEnabled', 'MusicBrainz', 'Identifies albums and fills in discographies.')}
        <SettingRow htmlFor="mb-url" label="MusicBrainz server" description="Point at your own mirror to lift the rate limit.">
          <Input id="mb-url" value={settings.musicBrainzBaseUrl} onChange={event => onChange({ musicBrainzBaseUrl: event.target.value })} className="h-9 w-64 font-mono text-[13px]" />
        </SettingRow>
        {toggle('coverArtArchiveEnabled', 'Cover Art Archive', 'Album covers.')}
        {toggle('deezerEnabled', 'Deezer', 'Search, artist images and top songs.')}
        {toggle('wikidataEnabled', 'Wikidata and Wikipedia', 'Artist images and bios.')}
        {toggle('lrclibEnabled', 'LRCLIB', 'Synced lyrics.')}
      </SettingsSection>
      <SettingsSection title="Keys" description="Stored encrypted and never shown again.">
        {secret('listenBrainzToken', settings.listenBrainzTokenSet, 'ListenBrainz', 'Top songs, similar artists and scrobbling.')}
        {secret('acoustIdKey', settings.acoustIdKeySet, 'AcoustID', 'Identifies untagged files by fingerprint.')}
        {secret('fanartKey', settings.fanartKeySet, 'fanart.tv', 'Better artist images.')}
        {secret('lastFmKey', settings.lastFmKeySet, 'Last.fm', 'Scrobbling for users who connect an account.')}
      </SettingsSection>
      <SettingsSection title="Library">
        <SettingRow label="Accept matches automatically above" description="Lower matches wait in the review queue.">
          <div className="flex w-56 items-center gap-3">
            <Slider label="Automatic match threshold" value={Math.round(settings.matchAutoAcceptScore * 100)} max={100} step={1} valueText={`${Math.round(settings.matchAutoAcceptScore * 100)}%`} onValueChange={value => onChange({ matchAutoAcceptScore: value / 100 })} />
            <span className="w-10 text-right text-sm font-semibold tabular">{Math.round(settings.matchAutoAcceptScore * 100)}%</span>
          </div>
        </SettingRow>
        <SettingRow htmlFor="grace-days" label="Keep missing files for" description="An unmounted drive does not empty the library during this time.">
          <Input id="grace-days" type="number" min={0} max={365} value={settings.missingFileGraceDays} onChange={event => onChange({ missingFileGraceDays: Number(event.target.value) })} className="h-9 w-20 text-right" />
          <span className="text-sm text-muted">days</span>
        </SettingRow>
        <SettingRow label="Transcode cache" description={`Up to ${formatBytes(settings.transcodeCacheMaxBytes)} on disk.`} />
      </SettingsSection>
    </div>
  )
}
