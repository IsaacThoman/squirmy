import { CreateLibraryRootRequest, LoginRequest, RegisterRequest, SetupRequest, UpdateLibraryRootRequest, type DirectoryListing, type LibraryRoot } from '@squirmy/contracts'
import { ArrowRight, Check, FolderOpen, FolderPlus, PartyPopper, RotateCw, ServerCrash } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useFormSubmit, type FormErrors } from '@/api/errors'
import { rootPathErrors } from '@/api/folders'
import { ManagedConfirmation, ManagedSwitch } from '@/components/admin/ManagedSwitch'
import { Logo } from '@/components/layout/Sidebar'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Badge, Skeleton, Spinner } from '@/components/ui/feedback'
import { Field, FormError, Input } from '@/components/ui/input'
import { formatRelative, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FolderPicker } from './FolderPicker'

/** A centered card over a soft wash of the accent color. */
function AuthFrame({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-12">
      <div aria-hidden className="absolute -top-40 left-1/2 -z-10 size-[44rem] -translate-x-1/2 rounded-full bg-accent opacity-[0.12] blur-[120px]" />
      <Logo className="mb-8" />
      <main className="w-full max-w-sm animate-slide-in rounded-3xl bg-sheet p-7 shadow-float">
        <h1 className="text-2xl font-extrabold tracking-[-0.03em]">{title}</h1>
        {description && <p className="mt-1.5 text-sm leading-relaxed text-muted">{description}</p>}
        <div className="mt-6">{children}</div>
      </main>
      {footer && <div className="mt-6 text-sm text-muted">{footer}</div>}
    </div>
  )
}

/** While the app asks the server who you are. */
export function SplashView() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6">
      <Logo />
      <Spinner label="Connecting" />
    </div>
  )
}

export function UnreachableView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <AuthFrame title="Can’t reach the server" description={message}>
      <div className="flex flex-col items-center gap-5">
        <div className="flex size-14 items-center justify-center rounded-full bg-selection text-accent"><ServerCrash className="size-6" /></div>
        <Button variant="primary" size="lg" className="w-full" onClick={onRetry}><RotateCw />Try again</Button>
      </div>
    </AuthFrame>
  )
}

type Credentials = { username: string; password: string }

// The forms below are `noValidate`: the contract schemas check them, worded like the rest of the app.

function CredentialFields({ value, onChange, errors, newPassword }: { value: Credentials; onChange: (value: Credentials) => void; errors: FormErrors; newPassword?: boolean }) {
  return (
    <>
      <Field label="Username" htmlFor="username" error={errors.username} hint={newPassword ? 'Letters, numbers, dots, dashes and underscores.' : undefined}>
        <Input id="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={value.username} onChange={event => onChange({ ...value, username: event.target.value })} aria-invalid={!!errors.username} aria-describedby="username-message" required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password" error={errors.password} hint={newPassword ? 'At least 8 characters.' : undefined}>
        <Input id="password" type="password" autoComplete={newPassword ? 'new-password' : 'current-password'} value={value.password} onChange={event => onChange({ ...value, password: event.target.value })} aria-invalid={!!errors.password} aria-describedby="password-message" required />
      </Field>
    </>
  )
}

export function LoginView({ serverName, inviteRequired, onSubmit }: { serverName: string; inviteRequired: boolean; onSubmit: (credentials: Credentials) => Promise<unknown> }) {
  const [value, setValue] = useState<Credentials>({ username: '', password: '' })
  const form = useFormSubmit(LoginRequest, onSubmit)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void form.submit(value)
  }
  return (
    <AuthFrame
      title={`Sign in to ${serverName}`}
      footer={<>{inviteRequired ? 'Have an invite?' : 'New here?'} <Link to="/register" className="font-semibold text-accent hover:underline">Create an account</Link></>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <CredentialFields value={value} onChange={setValue} errors={form.errors} />
        <FormError message={form.errors.form} />
        <Button type="submit" variant="primary" size="lg" className="mt-2" pending={form.pending}>Sign in</Button>
      </form>
    </AuthFrame>
  )
}

type RegisterProps = {
  serverName: string
  inviteCode: string
  inviteRequired: boolean
  onSubmit: (request: RegisterRequest) => Promise<unknown>
}

const registerFields = { invalid_invite: 'inviteCode', invite_required: 'inviteCode', username_taken: 'username' }

export function RegisterView({ serverName, inviteCode, inviteRequired, onSubmit }: RegisterProps) {
  const [value, setValue] = useState<Credentials>({ username: '', password: '' })
  const [code, setCode] = useState(inviteCode)
  const form = useFormSubmit(RegisterRequest, onSubmit, registerFields)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void form.submit({ ...value, inviteCode: code.trim() || undefined })
  }
  const missingInvite = inviteRequired && !code.trim()
  return (
    <AuthFrame
      title={`Join ${serverName}`}
      description={inviteCode ? 'Someone invited you. Pick a username and password.' : inviteRequired ? 'Joining needs an invite. Paste the code from your link, then pick a username and password.' : 'Pick a username and password.'}
      footer={<>Already have an account? <Link to="/login" className="font-semibold text-accent hover:underline">Sign in</Link></>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label={inviteRequired ? 'Invite code' : 'Invite code (optional)'} htmlFor="invite" error={form.errors.inviteCode}>
          <Input id="invite" value={code} onChange={event => setCode(event.target.value)} className="font-mono tracking-wide" autoComplete="off" spellCheck={false} aria-invalid={!!form.errors.inviteCode} aria-describedby="invite-message" required={inviteRequired} />
        </Field>
        <CredentialFields value={value} onChange={setValue} errors={form.errors} newPassword />
        <FormError message={form.errors.form} />
        <Button type="submit" variant="primary" size="lg" className="mt-2" pending={form.pending} disabled={missingInvite}>Create account</Button>
      </form>
    </AuthFrame>
  )
}

const steps = ['Your account', 'Your music', 'Done']

function SetupFrame({ step, title, description, children }: { step: number; title: string; description: ReactNode; children: ReactNode }) {
  return (
    <AuthFrame title={title} description={description}>
      <ol aria-label="Setup progress" className="-mt-2 mb-6 flex gap-1.5">
        {steps.map((label, index) => (
          <li key={label} aria-current={index === step ? 'step' : undefined} className="flex-1">
            <span className={cn('block h-1 rounded-full transition-colors duration-200', index <= step ? 'bg-accent' : 'bg-stroke')} />
            <span className={cn('mt-1.5 flex items-center gap-1 text-[11px] font-semibold', index === step ? 'text-foreground' : 'text-quiet')}>
              {index < step && <Check className="size-3 text-accent" />}{label}
            </span>
          </li>
        ))}
      </ol>
      {children}
    </AuthFrame>
  )
}

/** First run, step one: the admin account. */
export function SetupAccountView({ onCreateAdmin }: { onCreateAdmin: (credentials: Credentials) => Promise<unknown> }) {
  const [account, setAccount] = useState<Credentials>({ username: '', password: '' })
  const form = useFormSubmit(SetupRequest, onCreateAdmin, { username_taken: 'username' })
  return (
    <SetupFrame step={0} title="Welcome to Squirmy" description="Create the admin account. You can invite everyone else later.">
      <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void form.submit(account) }} noValidate>
        <CredentialFields value={account} onChange={setAccount} errors={form.errors} newPassword />
        <FormError message={form.errors.form} />
        <Button type="submit" variant="primary" size="lg" className="mt-2" pending={form.pending}>Continue<ArrowRight /></Button>
      </form>
    </SetupFrame>
  )
}

type SetupLibraryProps = {
  /** Folders the server already has, such as the one its configuration adds at startup. Undefined while loading. */
  roots: LibraryRoot[] | undefined
  /** The folder the admin tried to add although the server already had it. */
  alreadyAdded: string | null
  path: string | undefined
  listing: DirectoryListing | undefined
  listingError: string | undefined
  onBrowse: (path: string) => void
  onAddFolder: (folder: CreateLibraryRootRequest) => Promise<unknown>
  onMakeManaged: (rootId: string, patch: UpdateLibraryRootRequest) => Promise<unknown>
  onContinue: () => void
}

/** Step two: the folders the server already scans, and another one picked by browsing the server. */
export function SetupLibraryView({ roots, alreadyAdded, path, listing, listingError, onBrowse, onAddFolder, onMakeManaged, onContinue }: SetupLibraryProps) {
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState<LibraryRoot | null>(null)
  const hasRoots = !!roots?.length
  return (
    <SetupFrame
      step={1}
      title="Where is your music?"
      description={hasRoots
        ? 'Squirmy already scans these folders and watches them for changes. Add another, or carry on.'
        : 'Pick a folder on this server. Squirmy scans it now and keeps watching it.'}
    >
      {!roots && <div className="flex flex-col gap-2">{[0, 1].map(index => <Skeleton key={index} className="h-[76px] rounded-xl" />)}</div>}
      {hasRoots && (
        <div className="flex flex-col gap-4">
          <ul aria-label="Music folders" className="flex flex-col gap-2">
            {roots.map(root => <SetupFolder key={root.id} root={root} alreadyAdded={root.id === alreadyAdded} onMakeManaged={() => setManaging(root)} />)}
          </ul>
          {adding
            ? <AddFolderForm path={path} listing={listing} listingError={listingError} onBrowse={onBrowse} onAddFolder={onAddFolder} onCancel={() => setAdding(false)} onAdded={() => setAdding(false)} />
            : (
              <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row">
                <Button variant="ghost" size="lg" onClick={() => setAdding(true)}><FolderPlus />Add another</Button>
                <Button variant="primary" size="lg" className="sm:flex-1" onClick={onContinue}>Continue<ArrowRight /></Button>
              </div>
            )}
        </div>
      )}
      {roots?.length === 0 && <AddFolderForm path={path} listing={listing} listingError={listingError} onBrowse={onBrowse} onAddFolder={onAddFolder} onCancel={onContinue} />}
      <Dialog open={!!managing} onOpenChange={open => { if (!open) setManaging(null) }}>
        {managing && <MakeManaged root={managing} onMakeManaged={onMakeManaged} onDone={() => setManaging(null)} />}
      </Dialog>
    </SetupFrame>
  )
}

function SetupFolder({ root, alreadyAdded, onMakeManaged }: { root: LibraryRoot; alreadyAdded: boolean; onMakeManaged: () => void }) {
  return (
    <li aria-label={root.name} className={cn('flex items-start gap-3 rounded-xl bg-surface px-3.5 py-3 ring-1 ring-transparent', alreadyAdded && 'ring-accent')}>
      <FolderOpen aria-hidden className="mt-0.5 size-5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold" title={root.name}>{root.name}</span>
          <Badge tone={root.mode === 'managed' ? 'accent' : 'neutral'}>{root.mode === 'managed' ? 'Managed' : 'Read-only'}</Badge>
          {alreadyAdded && <Badge tone="outline">Already added</Badge>}
        </div>
        <p dir="rtl" className="truncate text-left font-mono text-xs text-muted" title={root.path}><bdi>{root.path}</bdi></p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-quiet">
          {root.scanning && <Spinner label="Scanning" className="size-3.5" />}
          {root.scanning ? `Scanning · ${plural(root.fileCount, 'file')} so far` : root.lastScanFinishedAt ? `${plural(root.fileCount, 'file')} · scanned ${formatRelative(root.lastScanFinishedAt)}` : 'Not scanned yet'}
        </p>
        {root.mode === 'read_only' && <Button variant="link" size="sm" className="mt-1 h-auto px-0" onClick={onMakeManaged}>Let Squirmy organize it…</Button>}
      </div>
    </li>
  )
}

function MakeManaged({ root, onMakeManaged, onDone }: { root: LibraryRoot; onMakeManaged: SetupLibraryProps['onMakeManaged']; onDone: () => void }) {
  const form = useFormSubmit(UpdateLibraryRootRequest, patch => onMakeManaged(root.id, patch))
  const confirm = async () => {
    if (await form.submit({ mode: 'managed' })) onDone()
  }
  return <ManagedConfirmation name={root.name} errors={form.errors} pending={form.pending} onConfirm={() => void confirm()} />
}

type AddFolderProps = Pick<SetupLibraryProps, 'path' | 'listing' | 'listingError' | 'onBrowse' | 'onAddFolder'> & {
  /** "Skip for now" when the server has no folder yet, else back to the list. */
  onCancel: () => void
  onAdded?: () => void
}

function AddFolderForm({ path, listing, listingError, onBrowse, onAddFolder, onCancel, onAdded }: AddFolderProps) {
  const [name, setName] = useState('Music')
  const [managed, setManaged] = useState(false)
  const form = useFormSubmit(CreateLibraryRootRequest, onAddFolder, rootPathErrors)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (await form.submit({ name, path: listing?.path ?? '', mode: managed ? 'managed' : 'read_only', watch: true })) onAdded?.()
  }
  return (
    <form className="flex flex-col gap-4" onSubmit={event => void submit(event)} noValidate>
      <Field label="Name" htmlFor="folder-name" error={form.errors.name}>
        <Input id="folder-name" value={name} onChange={event => setName(event.target.value)} aria-invalid={!!form.errors.name} aria-describedby="folder-name-message" />
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-semibold text-muted">Folder</span>
        <FolderPicker path={path} listing={listing} error={listingError ?? form.errors.path} onBrowse={next => { form.reset(); onBrowse(next) }} />
      </div>
      <ManagedSwitch checked={managed} onChange={setManaged} />
      <FormError message={form.errors.form} />
      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row">
        <Button variant="ghost" size="lg" onClick={onCancel}>{onAdded ? 'Cancel' : 'Skip for now'}</Button>
        <Button type="submit" variant="primary" size="lg" className="sm:flex-1" pending={form.pending} disabled={!listing}><FolderOpen />Add and scan</Button>
      </div>
    </form>
  )
}

/** Step three. `folderPaths` are the library's folders, if it has any. */
export function SetupDoneView({ folderPaths, onFinish }: { folderPaths: string[]; onFinish: () => void }) {
  return (
    <SetupFrame
      step={2}
      title="You’re all set"
      description={folderPaths.length
        ? 'Music shows up as soon as its tags are read, and identification carries on in the background. Add more folders whenever you like, from Admin → Library.'
        : 'Add your music folders whenever you are ready, from Admin → Library.'}
    >
      <div className="flex flex-col items-center gap-5 text-center">
        <div className="flex size-16 items-center justify-center rounded-full bg-selection text-accent"><PartyPopper className="size-7" /></div>
        {folderPaths.length > 0 && (
          <div className="text-sm text-muted">
            <p>{folderPaths.length === 1 ? 'Your music folder' : 'Your music folders'}</p>
            <ul>{folderPaths.map(path => <li key={path} className="break-all font-mono text-foreground">{path}</li>)}</ul>
          </div>
        )}
        <Button variant="primary" size="lg" className="w-full" onClick={onFinish}>Start listening</Button>
      </div>
    </SetupFrame>
  )
}
