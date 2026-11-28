import { CreateLibraryRootRequest, LoginRequest, RegisterRequest, SecondFactorCode, SetupRequest, UpdateLibraryRootRequest, type DirectoryListing, type LibraryRoot } from '@squirmy/contracts'
import { ArrowLeft, ArrowRight, Check, Folder, FolderOpen, FolderPlus, Info, KeyRound, RotateCw, ServerCrash } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { errorMessage, useFormSubmit, type FormErrors } from '@/api/errors'
import { rootPathErrors } from '@/api/folders'
import { ManagedConfirmation, ManagedSwitch } from '@/components/admin/ManagedSwitch'
import { Logo } from '@/components/layout/Logo'
import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Badge, Skeleton, Spinner } from '@/components/ui/feedback'
import { Field, FormError, Input } from '@/components/ui/input'
import { formatRelative, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FolderPicker } from './FolderPicker'

const quietLinkClass = 'rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring'

type AuthFrameProps = {
  title: string
  description?: ReactNode
  /** A strip across the top of the card: the wizard's steps. */
  header?: ReactNode
  /** Under the form, inside the card: the way to the other form. */
  footer?: ReactNode
  /** The server's version, shown under the card. */
  version?: string
  /** For steps with more than a couple of fields. */
  wide?: boolean
  children: ReactNode
}

/** The logo over a centered card, for every page shown before the app itself. */
function AuthFrame({ title, description, header, footer, version, wide, children }: AuthFrameProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <Logo className="mb-8" />
      <main className={cn('w-full animate-slide-in overflow-hidden rounded-xl border bg-card shadow-xs', wide ? 'max-w-lg' : 'max-w-sm')}>
        {header}
        <div className="p-6">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          <div className="mt-6">{children}</div>
          {footer && <p className="mt-6 text-center text-sm text-muted-foreground">{footer}</p>}
        </div>
      </main>
      {version && <p className="mt-6 text-xs text-muted-foreground">Squirmy {version}</p>}
    </div>
  )
}

/** While the app asks the server who you are. */
export function SplashView() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background">
      <Logo />
      <Spinner label="Connecting" />
    </div>
  )
}

export function UnreachableView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <AuthFrame title="Can’t reach the server" description={message}>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
          <ServerCrash aria-hidden className="size-4 shrink-0" />
          <span>Check that the server is running and that this device can reach it.</span>
        </div>
        <Button variant="primary" className="w-full" onClick={onRetry}><RotateCw />Try again</Button>
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

type LoginProps = {
  serverName: string
  version: string
  inviteRequired: boolean
  /** Why sign-in is showing, when the visitor did not sign out themselves: their session ended. */
  notice?: string | null
  onSubmit: (credentials: Credentials) => Promise<unknown>
  /** Offered when the server and this browser can both use passkeys. Resolves once signed in, or quietly when cancelled. */
  onPasskey?: () => Promise<unknown>
}

export function LoginView({ serverName, version, inviteRequired, notice, onSubmit, onPasskey }: LoginProps) {
  const [value, setValue] = useState<Credentials>({ username: '', password: '' })
  const form = useFormSubmit(LoginRequest, onSubmit)
  const [passkeyPending, setPasskeyPending] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string>()
  const signInWithPasskey = async () => {
    setPasskeyPending(true)
    setPasskeyError(undefined)
    form.reset()
    try {
      await onPasskey!()
    } catch (error) {
      setPasskeyError(errorMessage(error))
    } finally {
      setPasskeyPending(false)
    }
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void form.submit(value)
  }
  return (
    <AuthFrame
      title={`Sign in to ${serverName}`}
      description="Welcome back. Your music is where you left it."
      version={version}
      footer={<>{inviteRequired ? 'Have an invite?' : 'New here?'} <Link to="/register" className={quietLinkClass}>Create an account</Link></>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {notice && (
          <div role="status" className="flex items-start gap-3 rounded-lg border bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{notice}</span>
          </div>
        )}
        <CredentialFields value={value} onChange={setValue} errors={form.errors} />
        <FormError message={form.errors.form ?? passkeyError} />
        <Button type="submit" variant="primary" className="mt-2 w-full" pending={form.pending}>Sign in</Button>
        {onPasskey && (
          <>
            <div aria-hidden className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
            <Button variant="outline" className="w-full" pending={passkeyPending} onClick={() => void signInWithPasskey()}><KeyRound />Sign in with a passkey</Button>
          </>
        )}
      </form>
    </AuthFrame>
  )
}

const TwoFactorForm = z.object({ code: SecondFactorCode })

type TwoFactorProps = {
  serverName: string
  version: string
  onSubmit: (code: string) => Promise<unknown>
  /** Back to the password, for a different account or an expired step. */
  onBack: () => void
}

/** The second step of a password sign-in, for an account with two-factor authentication on. */
export function TwoFactorView({ serverName, version, onSubmit, onBack }: TwoFactorProps) {
  const [code, setCode] = useState('')
  const form = useFormSubmit(TwoFactorForm, value => onSubmit(value.code), { invalid_code: 'code' })
  return (
    <AuthFrame
      title="Enter your code"
      description={`Open your authenticator app and enter the code it shows for ${serverName}.`}
      version={version}
      footer={<button type="button" onClick={onBack} className={cn(quietLinkClass, 'inline-flex items-center gap-1')}><ArrowLeft aria-hidden className="size-3.5" />Back to sign in</button>}
    >
      <form onSubmit={event => { event.preventDefault(); void form.submit({ code }) }} className="flex flex-col gap-4" noValidate>
        <Field label="Authentication code" htmlFor="code" error={form.errors.code} hint="Lost your phone? Enter one of your recovery codes.">
          <Input id="code" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} className="font-mono tracking-wider" value={code} onChange={event => setCode(event.target.value)} aria-invalid={!!form.errors.code} aria-describedby="code-message" required autoFocus />
        </Field>
        <FormError message={form.errors.form} />
        <Button type="submit" variant="primary" className="mt-2 w-full" pending={form.pending}>Verify</Button>
      </form>
    </AuthFrame>
  )
}

type RegisterProps = {
  serverName: string
  version?: string
  inviteCode: string
  inviteRequired: boolean
  onSubmit: (request: RegisterRequest) => Promise<unknown>
}

const registerFields = { invalid_invite: 'inviteCode', invite_required: 'inviteCode', username_taken: 'username' }

export function RegisterView({ serverName, version, inviteCode, inviteRequired, onSubmit }: RegisterProps) {
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
      version={version}
      footer={<>Already have an account? <Link to="/login" className={quietLinkClass}>Sign in</Link></>}
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label={inviteRequired ? 'Invite code' : 'Invite code (optional)'} htmlFor="invite" error={form.errors.inviteCode}>
          <Input id="invite" value={code} onChange={event => setCode(event.target.value)} className="font-mono" autoComplete="off" spellCheck={false} aria-invalid={!!form.errors.inviteCode} aria-describedby="invite-message" required={inviteRequired} />
        </Field>
        <CredentialFields value={value} onChange={setValue} errors={form.errors} newPassword />
        <FormError message={form.errors.form} />
        <Button type="submit" variant="primary" className="mt-2 w-full" pending={form.pending} disabled={missingInvite}>Create account</Button>
      </form>
    </AuthFrame>
  )
}

const steps = ['Account', 'Music', 'Done']

/** Where the wizard is: steps behind are checked, the current one stands out. */
function SetupSteps({ step }: { step: number }) {
  return (
    <ol aria-label="Setup progress" className="flex items-center gap-2 border-b bg-muted/40 px-6 py-3 text-xs">
      {steps.map((label, index) => (
        <li key={label} aria-current={index === step ? 'step' : undefined} className={cn('flex items-center gap-2', index === step ? 'font-medium text-foreground' : 'text-muted-foreground', index > 0 && 'min-w-0 flex-1')}>
          {index > 0 && <span aria-hidden className={cn('h-px min-w-3 flex-1', index <= step ? 'bg-primary/40' : 'bg-border')} />}
          <span
            className={cn(
              'flex size-5 shrink-0 items-center justify-center rounded-full tabular',
              index < step ? 'bg-primary/12 text-primary' : index === step ? 'bg-primary text-primary-foreground' : 'border bg-card',
            )}
          >
            {index < step ? <Check className="size-3" strokeWidth={3} /> : index + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  )
}

function SetupFrame({ step, title, description, wide, children }: { step: number; title: string; description: ReactNode; wide?: boolean; children: ReactNode }) {
  return <AuthFrame title={title} description={description} header={<SetupSteps step={step} />} wide={wide}>{children}</AuthFrame>
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
        <Button type="submit" variant="primary" className="mt-2 w-full" pending={form.pending}>Continue<ArrowRight /></Button>
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
      wide
      title="Where is your music?"
      description={hasRoots
        ? 'Squirmy already scans these folders and watches them for changes. Add another, or carry on.'
        : 'Pick a folder on this server. Squirmy scans it now and keeps watching it.'}
    >
      {!roots && (
        <div className="divide-y rounded-lg border">
          {[0, 1].map(index => (
            <div key={index} className="flex gap-3 px-3 py-3">
              <Skeleton className="size-4" />
              <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-32" /><Skeleton className="h-3 w-56 max-w-full" /></div>
            </div>
          ))}
        </div>
      )}
      {hasRoots && (
        <div className="flex flex-col gap-6">
          <ul aria-label="Music folders" className="divide-y overflow-hidden rounded-lg border">
            {roots.map(root => <SetupFolder key={root.id} root={root} alreadyAdded={root.id === alreadyAdded} onMakeManaged={() => setManaging(root)} />)}
          </ul>
          {adding
            ? <AddFolderForm path={path} listing={listing} listingError={listingError} onBrowse={onBrowse} onAddFolder={onAddFolder} onCancel={() => setAdding(false)} onAdded={() => setAdding(false)} />
            : (
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button variant="outline" onClick={() => setAdding(true)}><FolderPlus />Add another</Button>
                <Button variant="primary" className="sm:flex-1" onClick={onContinue}>Continue<ArrowRight /></Button>
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
    <li aria-label={root.name} className={cn('flex items-start gap-3 px-3 py-3', alreadyAdded && 'bg-primary/10')}>
      <Folder aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium" title={root.name}>{root.name}</span>
          <Badge tone={root.mode === 'managed' ? 'accent' : 'neutral'}>{root.mode === 'managed' ? 'Managed' : 'Read-only'}</Badge>
          {alreadyAdded && <Badge tone="outline" className="bg-card">Already added</Badge>}
        </div>
        <p dir="rtl" className="mt-0.5 truncate text-left font-mono text-xs text-muted-foreground" title={root.path}><bdi>{root.path}</bdi></p>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          {root.scanning && <Spinner label="Scanning" className="size-3.5" />}
          {root.scanning ? `Scanning · ${plural(root.fileCount, 'file')} so far` : root.lastScanFinishedAt ? `${plural(root.fileCount, 'file')} · scanned ${formatRelative(root.lastScanFinishedAt)}` : 'Not scanned yet'}
        </p>
        {root.mode === 'read_only' && <Button variant="link" size="sm" className="mt-1.5 text-xs" onClick={onMakeManaged}>Let Squirmy organize it…</Button>}
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
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium leading-none">Folder</span>
        <FolderPicker path={path} listing={listing} error={listingError ?? form.errors.path} onBrowse={next => { form.reset(); onBrowse(next) }} />
      </div>
      <ManagedSwitch checked={managed} onChange={setManaged} />
      <FormError message={form.errors.form} />
      <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row">
        <Button variant="outline" onClick={onCancel}>{onAdded ? 'Cancel' : 'Skip for now'}</Button>
        <Button type="submit" variant="primary" className="sm:flex-1" pending={form.pending} disabled={!listing}><FolderOpen />Add and scan</Button>
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
      <div className="flex flex-col gap-6">
        {folderPaths.length > 0 && (
          <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">{folderPaths.length === 1 ? 'Your music folder' : 'Your music folders'}</p>
            <ul className="mt-1.5 flex flex-col gap-1.5">
              {folderPaths.map(path => (
                <li key={path} className="flex items-start gap-2 text-xs">
                  <Folder aria-hidden className="mt-px size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 break-all font-mono text-foreground">{path}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button variant="primary" className="w-full" onClick={onFinish}>Start listening</Button>
      </div>
    </SetupFrame>
  )
}
