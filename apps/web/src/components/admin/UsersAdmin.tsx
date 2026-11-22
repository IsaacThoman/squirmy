import { CreateInviteRequest, CreateUserRequest, Password, UpdateUserRequest, type Invite, type User, type UserRole } from '@squirmy/contracts'
import { Check, Copy, KeyRound, MoreHorizontal, Pencil, Plus, Ticket, Trash2, UserCheck, UserPlus, UserX } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { z } from 'zod'
import { useFormSubmit } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Badge, EmptyState, Skeleton } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input } from '@/components/ui/input'
import { DropdownMenu } from '@/components/ui/menu'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatDate, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader, DialogForm } from './AdminLayout'
import { cardClass, DataTable, OptionGroup, OptionRow, Panel, Td, Th, Tr } from './Panel'

type UsersAdminProps = {
  /** Undefined while loading. */
  users: User[] | undefined
  invites: Invite[] | undefined
  currentUserId: string
  inviteLink: (invite: Invite) => string
  onCreateUser: (request: z.input<typeof CreateUserRequest>) => Promise<unknown>
  onUpdateUser: (userId: string, patch: UpdateUserRequest) => Promise<unknown>
  onDeleteUser: (userId: string) => Promise<unknown>
  onCreateInvite: (request: CreateInviteRequest) => Promise<Invite>
  onRevokeInvite: (inviteId: string) => Promise<unknown>
}

type UserDialog = { kind: 'edit' | 'password' | 'disable' | 'delete'; user: User } | { kind: 'create' | 'invite' } | { kind: 'revoke'; invite: Invite }

const roleOptions = [{ value: 'member', label: 'Member' }, { value: 'admin', label: 'Admin' }] as const

export function UsersAdmin({ users, invites, currentUserId, inviteLink, onCreateUser, onUpdateUser, onDeleteUser, onCreateInvite, onRevokeInvite }: UsersAdminProps) {
  const [dialog, setDialog] = useState<UserDialog | null>(null)
  const close = (open: boolean) => { if (!open) setDialog(null) }
  const name = (user: User) => user.displayName ?? user.username
  return (
    <div>
      <AdminHeader title="Users & invites" description="Everyone shares one library. Likes, playlists, history and playback are each person’s own.">
        <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'create' })}><UserPlus />Add user</Button>
        <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'invite' })}><Plus />Invite someone</Button>
      </AdminHeader>

      <div className="flex flex-col gap-7">
        <Panel title={<>Users{users && <span className="ml-1.5 font-normal tabular text-muted-foreground">{users.length}</span>}</>}>
          <DataTable>
            <thead>
              <tr className="border-b">
                <Th className="w-full">User</Th>
                <Th className="max-sm:hidden">Role</Th>
                <Th className="max-sm:hidden">Joined</Th>
                <Th><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {!users && <LoadingRows columns={4} />}
              {users?.map(user => {
                const access = (
                  <>
                    <Badge tone={user.role === 'admin' ? 'accent' : 'neutral'} className="capitalize">{user.role}</Badge>
                    {user.canUpload && <Badge tone="outline">Upload</Badge>}
                    {user.canAcquire && <Badge tone="outline">Fetch</Badge>}
                  </>
                )
                return (
                  <Tr key={user.id}>
                    {/* The one column that gives way: it takes what the others leave and cuts long names short. */}
                    <Td className="w-full max-w-0">
                      <span className="flex items-center gap-2.5">
                        <span aria-hidden className={cn('flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-medium', user.role === 'admin' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground', user.disabled && 'opacity-50')}>
                          {name(user).slice(0, 1).toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className={cn('truncate font-medium', user.disabled && 'text-muted-foreground line-through')}>{name(user)}</span>
                            {user.id === currentUserId && <span className="shrink-0 text-muted-foreground">(you)</span>}
                            {user.disabled && <Badge tone="danger">Disabled</Badge>}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground" title={`@${user.username}`}>@{user.username}<span className="sm:hidden"> · joined {formatDate(user.createdAt)}</span></span>
                          {/* Where the role and joined columns do not fit, they are under the name. */}
                          <span className="mt-1.5 flex flex-wrap gap-1 sm:hidden">{access}</span>
                        </span>
                      </span>
                    </Td>
                    <Td className="max-sm:hidden"><span className="flex items-center gap-1">{access}</span></Td>
                    <Td className="whitespace-nowrap tabular text-muted-foreground max-sm:hidden">{formatDate(user.createdAt)}</Td>
                    <Td className="py-1 text-right">
                      <DropdownMenu
                        entries={[
                          { label: 'Edit…', icon: <Pencil />, onSelect: () => setDialog({ kind: 'edit', user }) },
                          { label: 'Reset password…', icon: <KeyRound />, onSelect: () => setDialog({ kind: 'password', user }) },
                          { kind: 'separator' },
                          user.disabled
                            ? { label: 'Enable account', icon: <UserCheck />, onSelect: () => void onUpdateUser(user.id, { disabled: false }).catch(() => {}) }
                            : { label: 'Disable account…', icon: <UserX />, danger: true, onSelect: () => setDialog({ kind: 'disable', user }) },
                          { label: 'Delete account…', icon: <Trash2 />, danger: true, disabled: user.id === currentUserId, onSelect: () => setDialog({ kind: 'delete', user }) },
                        ]}
                        trigger={<IconButton label={`Manage ${user.username}`} size="sm"><MoreHorizontal /></IconButton>}
                      />
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        </Panel>

        <Panel title="Invites" description="Share a link. Each one works once.">
          {invites?.length === 0 ? (
            <EmptyState className={cn(cardClass, 'py-10')} icon={<Ticket />} title="No invites" description="Create one to let someone join." />
          ) : (
            <DataTable>
              <thead>
                <tr className="border-b">
                  <Th className="w-full">Code</Th>
                  <Th className="max-sm:hidden">Role</Th>
                  <Th className="max-sm:hidden">Status</Th>
                  <Th><span className="sr-only">Actions</span></Th>
                </tr>
              </thead>
              <tbody>
                {!invites && <LoadingRows columns={4} />}
                {invites?.map(invite => {
                  const state = inviteState(invite)
                  const status = state === 'used' ? `Used by @${invite.usedBy}` : invite.expiresAt ? `${state === 'expired' ? 'Expired' : 'Expires'} ${formatRelative(invite.expiresAt)}` : 'Never expires'
                  const badges = (
                    <>
                      <Badge tone={invite.role === 'admin' ? 'accent' : 'neutral'} className="capitalize">{invite.role}</Badge>
                      {state === 'expired' && <Badge tone="outline">Expired</Badge>}
                    </>
                  )
                  return (
                    <Tr key={invite.id}>
                      <Td className="w-full max-w-0">
                        <code className={cn('block truncate font-mono text-xs', state !== 'open' && 'text-muted-foreground')}>{invite.code}</code>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground sm:hidden">{status}</span>
                        <span className="mt-1.5 flex flex-wrap gap-1 sm:hidden">{badges}</span>
                      </Td>
                      <Td className="max-sm:hidden"><span className="flex items-center gap-1">{badges}</span></Td>
                      <Td className="whitespace-nowrap text-muted-foreground max-sm:hidden">{status}</Td>
                      <Td className="py-1">
                        <span className="flex items-center justify-end gap-1">
                          {state === 'open' && <CopyLinkButton link={inviteLink(invite)} />}
                          {state !== 'used' && <Button size="sm" variant="ghost" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setDialog({ kind: 'revoke', invite })}><Trash2 className="sm:hidden" /><span className="max-sm:sr-only">{state === 'open' ? 'Revoke' : 'Remove'}</span></Button>}
                        </span>
                      </Td>
                    </Tr>
                  )
                })}
              </tbody>
            </DataTable>
          )}
        </Panel>
      </div>

      <CreateUserDialog open={dialog?.kind === 'create'} onOpenChange={close} onCreate={onCreateUser} />
      <InviteDialog open={dialog?.kind === 'invite'} onOpenChange={close} onCreate={onCreateInvite} inviteLink={inviteLink} />
      {dialog?.kind === 'edit' && <EditUserDialog user={dialog.user} isSelf={dialog.user.id === currentUserId} onOpenChange={close} onSave={patch => onUpdateUser(dialog.user.id, patch)} />}
      {dialog?.kind === 'password' && <ResetPasswordDialog user={dialog.user} onOpenChange={close} onReset={password => onUpdateUser(dialog.user.id, { password })} />}
      <ConfirmDialog
        open={dialog?.kind === 'disable'}
        onOpenChange={close}
        title={dialog?.kind === 'disable' ? `Disable @${dialog.user.username}?` : ''}
        description={dialog?.kind === 'disable' && dialog.user.id === currentUserId ? 'You are signed out right away and cannot sign back in until another admin enables you.' : 'They are signed out everywhere and cannot sign in until you enable the account again.'}
        confirmLabel="Disable"
        onConfirm={() => dialog?.kind === 'disable' ? onUpdateUser(dialog.user.id, { disabled: true }) : Promise.resolve()}
      />
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={close}
        title={dialog?.kind === 'delete' ? `Delete @${dialog.user.username}?` : ''}
        description="Their likes, playlists and history are deleted too. The shared library stays."
        confirmLabel="Delete"
        onConfirm={() => dialog?.kind === 'delete' ? onDeleteUser(dialog.user.id) : Promise.resolve()}
      />
      <ConfirmDialog
        open={dialog?.kind === 'revoke'}
        onOpenChange={close}
        title={dialog?.kind === 'revoke' ? `Revoke ${dialog.invite.code}?` : ''}
        description="The link stops working. Accounts already made with it stay."
        confirmLabel="Revoke"
        onConfirm={() => dialog?.kind === 'revoke' ? onRevokeInvite(dialog.invite.id) : Promise.resolve()}
      />
    </div>
  )
}

function inviteState(invite: Invite, now = Date.now()): 'open' | 'used' | 'expired' {
  if (invite.usedBy) return 'used'
  return invite.expiresAt && Date.parse(invite.expiresAt) <= now ? 'expired' : 'open'
}

function LoadingRows({ columns }: { columns: number }) {
  return [0, 1].map(index => (
    <tr key={index} className="border-b last:border-0">
      <td colSpan={columns} className="px-4 py-2.5"><Skeleton className="h-4 w-40" /><Skeleton className="mt-1.5 h-3 w-56 max-w-full" /></td>
    </tr>
  ))
}

function CopyLinkButton({ link }: { link: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => navigator.clipboard.writeText(link).then(() => setCopied(true), () => {})
  return <Button size="sm" variant="ghost" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}<span className="max-sm:sr-only">{copied ? 'Copied' : 'Copy link'}</span></Button>
}

type Access = { role: UserRole; canUpload: boolean; canAcquire: boolean }

function AccessFields({ value, onChange, roleLocked }: { value: Access; onChange: (value: Access) => void; roleLocked?: ReactNode }) {
  return (
    <>
      <OptionRow label="Role" description={roleLocked ?? 'Admins manage folders, users and settings.'}>
        <Select label="Role" size="sm" value={value.role} onValueChange={role => onChange({ ...value, role })} options={roleOptions} />
      </OptionRow>
      <OptionRow label="Can upload music"><Switch aria-label="Can upload music" checked={value.canUpload} onCheckedChange={canUpload => onChange({ ...value, canUpload })} /></OptionRow>
      <OptionRow label="Can fetch missing music" description="Through an acquisition provider."><Switch aria-label="Can fetch missing music" checked={value.canAcquire} onCheckedChange={canAcquire => onChange({ ...value, canAcquire })} /></OptionRow>
    </>
  )
}

const newUser = { username: '', password: '', displayName: '', role: 'member' as UserRole, canUpload: false, canAcquire: false }

function CreateUserDialog({ open, onOpenChange, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: UsersAdminProps['onCreateUser'] }) {
  const [value, setValue] = useState(newUser)
  const form = useFormSubmit(CreateUserRequest, onCreate, { username_taken: 'username' })
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setValue(newUser)
      form.reset()
    }
  }
  const submit = async () => {
    if (await form.submit({ ...value, displayName: value.displayName.trim() || null })) close(false)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Add a user" description="Make an account directly and pass on the password. An invite lets them choose their own.">
        <DialogForm onSubmit={() => void submit()} errors={form.errors} pending={form.pending} submitLabel="Add user">
          <Field label="Username" htmlFor="new-username" error={form.errors.username}>
            <Input id="new-username" value={value.username} onChange={event => setValue({ ...value, username: event.target.value })} autoComplete="off" autoCapitalize="none" spellCheck={false} aria-invalid={!!form.errors.username} autoFocus />
          </Field>
          <Field label="Display name (optional)" htmlFor="new-display-name" error={form.errors.displayName}>
            <Input id="new-display-name" value={value.displayName} onChange={event => setValue({ ...value, displayName: event.target.value })} aria-invalid={!!form.errors.displayName} />
          </Field>
          <Field label="Password" htmlFor="new-password" error={form.errors.password} hint="At least 8 characters.">
            <Input id="new-password" type="password" autoComplete="new-password" value={value.password} onChange={event => setValue({ ...value, password: event.target.value })} aria-invalid={!!form.errors.password} />
          </Field>
          <OptionGroup><AccessFields value={value} onChange={access => setValue({ ...value, ...access })} /></OptionGroup>
        </DialogForm>
      </DialogContent>
    </Dialog>
  )
}

function EditUserDialog({ user, isSelf, onOpenChange, onSave }: { user: User; isSelf: boolean; onOpenChange: (open: boolean) => void; onSave: (patch: UpdateUserRequest) => Promise<unknown> }) {
  const [value, setValue] = useState({ displayName: user.displayName ?? '', role: user.role, canUpload: user.canUpload, canAcquire: user.canAcquire })
  const form = useFormSubmit(UpdateUserRequest, onSave)
  const submit = async () => {
    if (await form.submit({ ...value, displayName: value.displayName.trim() || null })) onOpenChange(false)
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={`Edit @${user.username}`}>
        <DialogForm onSubmit={() => void submit()} errors={form.errors} pending={form.pending} submitLabel="Save">
          <Field label="Display name" htmlFor="edit-display-name" error={form.errors.displayName}>
            <Input id="edit-display-name" value={value.displayName} onChange={event => setValue({ ...value, displayName: event.target.value })} placeholder={user.username} aria-invalid={!!form.errors.displayName} autoFocus />
          </Field>
          <OptionGroup>
            <AccessFields value={value} onChange={access => setValue({ ...value, ...access })} roleLocked={isSelf && value.role === 'member' ? 'You lose access to Admin when you save.' : undefined} />
          </OptionGroup>
        </DialogForm>
      </DialogContent>
    </Dialog>
  )
}

const ResetPassword = z.object({ password: Password })

function ResetPasswordDialog({ user, onOpenChange, onReset }: { user: User; onOpenChange: (open: boolean) => void; onReset: (password: string) => Promise<unknown> }) {
  const [password, setPassword] = useState('')
  const form = useFormSubmit(ResetPassword, value => onReset(value.password))
  const submit = async () => {
    if (await form.submit({ password })) onOpenChange(false)
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={`New password for @${user.username}`} description="They are signed out everywhere, and their app passwords are deleted.">
        <DialogForm onSubmit={() => void submit()} errors={form.errors} pending={form.pending} submitLabel="Set password">
          <Field label="New password" htmlFor="reset-password" error={form.errors.password} hint="At least 8 characters.">
            <Input id="reset-password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} aria-invalid={!!form.errors.password} autoFocus />
          </Field>
        </DialogForm>
      </DialogContent>
    </Dialog>
  )
}

type Expiry = '1' | '7' | '14' | '30' | 'never'
const expiryOptions = [{ value: '1', label: 'In a day' }, { value: '7', label: 'In 7 days' }, { value: '14', label: 'In 14 days' }, { value: '30', label: 'In 30 days' }, { value: 'never', label: 'Never' }] as const

function InviteDialog({ open, onOpenChange, onCreate, inviteLink }: { open: boolean; onOpenChange: (open: boolean) => void; onCreate: UsersAdminProps['onCreateInvite']; inviteLink: UsersAdminProps['inviteLink'] }) {
  const [access, setAccess] = useState<Access>({ role: 'member', canUpload: false, canAcquire: false })
  const [expiry, setExpiry] = useState<Expiry>('14')
  const [created, setCreated] = useState<Invite | null>(null)
  const form = useFormSubmit(CreateInviteRequest, async request => setCreated(await onCreate(request)))
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setCreated(null)
      form.reset()
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        title={created ? 'Send this link' : 'Invite someone'}
        description={created ? `It works once${created.expiresAt ? `, until ${formatDate(created.expiresAt)}` : ''}. They choose their own username and password.` : 'They choose their own username and password when they open the link.'}
      >
        {created ? (
          <div className="flex flex-col gap-4">
            <CopyField value={inviteLink(created)} label="Invite link" />
            <DialogFooter><DialogClose asChild><Button variant="outline">Done</Button></DialogClose></DialogFooter>
          </div>
        ) : (
          <DialogForm onSubmit={() => void form.submit({ ...access, expiresInDays: expiry === 'never' ? null : Number(expiry) })} errors={form.errors} pending={form.pending} submitLabel="Create invite">
            <OptionGroup>
              <AccessFields value={access} onChange={setAccess} />
              <OptionRow label="Link expires">
                <Select label="Link expires" size="sm" value={expiry} onValueChange={setExpiry} options={expiryOptions} />
              </OptionRow>
            </OptionGroup>
          </DialogForm>
        )}
      </DialogContent>
    </Dialog>
  )
}
