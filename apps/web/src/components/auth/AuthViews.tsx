import { ArrowRight, Check, FolderOpen, PartyPopper } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import { ManagedSwitch } from '@/components/admin/LibraryAdmin'
import { Logo } from '@/components/layout/Sidebar'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** A centered card over a soft wash of the accent color. */
function AuthFrame({ title, description, children, footer }: { title: string; description?: string; children: ReactNode; footer?: ReactNode }) {
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

type Credentials = { username: string; password: string }

function CredentialFields({ value, onChange, newPassword }: { value: Credentials; onChange: (value: Credentials) => void; newPassword?: boolean }) {
  return (
    <>
      <Field label="Username" htmlFor="username" hint={newPassword ? 'Letters, numbers, dots, dashes and underscores.' : undefined}>
        <Input id="username" autoComplete="username" value={value.username} onChange={event => onChange({ ...value, username: event.target.value })} required autoFocus />
      </Field>
      <Field label="Password" htmlFor="password" hint={newPassword ? 'At least 8 characters.' : undefined}>
        <Input id="password" type="password" autoComplete={newPassword ? 'new-password' : 'current-password'} minLength={newPassword ? 8 : undefined} value={value.password} onChange={event => onChange({ ...value, password: event.target.value })} required />
      </Field>
    </>
  )
}

export function LoginView({ serverName, error, onSubmit }: { serverName: string; error?: string; onSubmit: (credentials: Credentials) => void }) {
  const [value, setValue] = useState<Credentials>({ username: '', password: '' })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit(value)
  }
  return (
    <AuthFrame title={`Sign in to ${serverName}`} footer={<>Have an invite? <Link to="/register" className="font-semibold text-accent hover:underline">Create an account</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <CredentialFields value={value} onChange={setValue} />
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="mt-2">Sign in</Button>
      </form>
    </AuthFrame>
  )
}

export function RegisterView({ serverName, inviteCode, onSubmit }: { serverName: string; inviteCode: string; onSubmit: (request: Credentials & { inviteCode: string }) => void }) {
  const [value, setValue] = useState<Credentials>({ username: '', password: '' })
  const [code, setCode] = useState(inviteCode)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit({ ...value, inviteCode: code.trim() })
  }
  return (
    <AuthFrame title={`Join ${serverName}`} description="Someone invited you. Pick a username and password." footer={<>Already have an account? <Link to="/login" className="font-semibold text-accent hover:underline">Sign in</Link></>}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Invite code" htmlFor="invite">
          <Input id="invite" value={code} onChange={event => setCode(event.target.value)} className="font-mono uppercase tracking-wide" required />
        </Field>
        <CredentialFields value={value} onChange={setValue} newPassword />
        <Button type="submit" variant="primary" size="lg" className="mt-2">Create account</Button>
      </form>
    </AuthFrame>
  )
}

const steps = ['Your account', 'Your music', 'Done']

type SetupProps = {
  onCreateAdmin: (credentials: Credentials) => void
  onAddFolder: (folder: { name: string; path: string; managed: boolean }) => void
  onFinish: () => void
}

/** First run: create the admin, point at the music, start listening. */
export function SetupView({ onCreateAdmin, onAddFolder, onFinish }: SetupProps) {
  const [step, setStep] = useState(0)
  const [account, setAccount] = useState<Credentials>({ username: '', password: '' })
  const [folder, setFolder] = useState({ name: 'Music', path: '', managed: false })

  return (
    <AuthFrame
      title={['Welcome to Squirmy', 'Where is your music?', 'You’re all set'][step]}
      description={[
        'Create the admin account. You can invite everyone else later.',
        'A folder on this server. Squirmy scans it now and keeps watching it.',
        'Your library is being scanned. Music shows up as soon as its tags are read, and identification carries on in the background.',
      ][step]}
    >
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
      {step === 0 && (
        <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); onCreateAdmin(account); setStep(1) }}>
          <CredentialFields value={account} onChange={setAccount} newPassword />
          <Button type="submit" variant="primary" size="lg" className="mt-2">Continue<ArrowRight /></Button>
        </form>
      )}
      {step === 1 && (
        <form className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); onAddFolder(folder); setStep(2) }}>
          <Field label="Name" htmlFor="folder-name"><Input id="folder-name" value={folder.name} onChange={event => setFolder({ ...folder, name: event.target.value })} required /></Field>
          <Field label="Path" htmlFor="folder-path" hint="As the server sees it, e.g. /music inside the container.">
            <Input id="folder-path" value={folder.path} onChange={event => setFolder({ ...folder, path: event.target.value })} placeholder="/music" className="font-mono" required autoFocus />
          </Field>
          <ManagedSwitch checked={folder.managed} onChange={managed => setFolder({ ...folder, managed })} />
          <div className="mt-2 flex gap-2">
            <Button variant="ghost" size="lg" onClick={() => setStep(0)}>Back</Button>
            <Button type="submit" variant="primary" size="lg" className="flex-1"><FolderOpen />Add and scan</Button>
          </div>
        </form>
      )}
      {step === 2 && (
        <div className="flex flex-col items-center gap-5 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-selection text-accent"><PartyPopper className="size-7" /></div>
          <p className="text-sm text-muted">Scanning <span className="font-mono text-foreground">{folder.path}</span></p>
          <Button variant="primary" size="lg" className="w-full" onClick={onFinish}>Start listening</Button>
        </div>
      )}
    </AuthFrame>
  )
}
