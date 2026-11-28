import {
  ConfirmTwoFactorRequest, EnableTwoFactorRequest, LinkSsoRequest, PasskeyName, StartPasskeyRequest, StartTwoFactorRequest,
  type AccountSecurity, type AuthSession, type Passkey, type RecoveryCodes, type SsoIdentity, type TwoFactorSetup,
} from '@squirmy/contracts'
import { AlertTriangle, Check, CircleCheck, Copy, KeyRound, Link2, Plus, ShieldCheck, ShieldOff } from 'lucide-react'
import { z } from 'zod'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { errorMessage, useFormSubmit } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Badge, Separator, Skeleton } from '@/components/ui/feedback'
import { Field, FormError, Input } from '@/components/ui/input'
import { Row } from '@/components/ui/section'
import { formatDate, formatRelative, plural } from '@/lib/format'
import { ssoMessage } from '@/lib/sso'
import { cn } from '@/lib/utils'
import { SessionList } from './SessionList'

export type SecuritySettingsProps = {
  /** Undefined while loading. */
  security: AccountSecurity | undefined
  /** Undefined while loading. */
  sessions: AuthSession[] | undefined
  /** Said in place of a part whose first read failed. */
  failures?: Partial<Record<'security' | 'sessions', ReactNode>>
  onStartTwoFactor: (request: StartTwoFactorRequest) => Promise<TwoFactorSetup>
  /** Resolves with the recovery codes, shown once. */
  onEnableTwoFactor: (request: EnableTwoFactorRequest) => Promise<RecoveryCodes>
  onDisableTwoFactor: (request: ConfirmTwoFactorRequest) => Promise<unknown>
  onRegenerateRecoveryCodes: (request: ConfirmTwoFactorRequest) => Promise<RecoveryCodes>
  onRevokeSession: (id: string) => Promise<unknown>
  onRevokeOtherSessions: () => Promise<unknown>
  /** Whether the server accepts passkeys (an https PUBLIC_URL) and this browser can make them. */
  passkeys: { server: boolean; browser: boolean }
  /** What a new passkey is called until it is renamed: this browser's name. */
  defaultPasskeyName: string
  /** Asks the browser for a new passkey and saves it. Resolves quietly when the person cancels. */
  onAddPasskey: (request: { currentPassword?: string; name: string }) => Promise<unknown>
  onRenamePasskey: (id: string, name: string) => Promise<unknown>
  onDeletePasskey: (id: string) => Promise<unknown>
  /** The server's single sign-on provider, or null when it has none. */
  sso: { name: string } | null
  /** Sends the browser to the provider to link the account; it comes back to this section. */
  onLinkSso: (request: { currentPassword?: string }) => Promise<unknown>
  onUnlinkSso: (id: string) => Promise<unknown>
  /** What the provider's return said: `linked`, or an error code. */
  ssoNotice?: string
}

/** Settings → Security: the second factor and where the account is signed in. */
export function SecuritySettings({
  security, sessions, failures, onStartTwoFactor, onEnableTwoFactor, onDisableTwoFactor, onRegenerateRecoveryCodes, onRevokeSession, onRevokeOtherSessions,
  passkeys, defaultPasskeyName, onAddPasskey, onRenamePasskey, onDeletePasskey, sso, onLinkSso, onUnlinkSso, ssoNotice,
}: SecuritySettingsProps) {
  const [dialog, setDialog] = useState<'enable' | 'disable' | 'codes' | 'passkey' | 'sso' | null>(null)
  const [unlinking, setUnlinking] = useState<SsoIdentity | null>(null)
  const hasPassword = security?.hasPassword ?? true
  const [renaming, setRenaming] = useState<Passkey | null>(null)
  const [removing, setRemoving] = useState<Passkey | null>(null)
  const [othersPending, setOthersPending] = useState(false)
  const [othersError, setOthersError] = useState<string>()
  const close = (next: boolean) => { if (!next) setDialog(null) }
  const twoFactor = security?.twoFactor
  const others = sessions?.filter(session => !session.current).length ?? 0
  const signOutOthers = async () => {
    setOthersPending(true)
    setOthersError(undefined)
    try {
      await onRevokeOtherSessions()
    } catch (error) {
      setOthersError(errorMessage(error))
    } finally {
      setOthersPending(false)
    }
  }
  return (
    <>
      {ssoNotice && (
        <p role="status" className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', ssoNotice === 'linked' ? 'border-primary/30 bg-primary/10' : 'border-destructive/30 bg-destructive/10 text-destructive')}>
          {ssoNotice === 'linked' ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" /> : <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />}
          {ssoNotice === 'linked' ? `Connected. You can sign in with ${sso?.name ?? 'single sign-on'} now.` : ssoMessage(ssoNotice)}
        </p>
      )}
      {sso && (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-sm font-medium">{sso.name}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Sign in through this server’s single sign-on.{hasPassword ? '' : ' Your account has no password: it signs in this way, or with a passkey.'}</p>
            </div>
            {security && security.ssoIdentities.length === 0 && <Button size="sm" variant="outline" onClick={() => setDialog('sso')}><Link2 />Connect</Button>}
          </div>
          {security?.ssoIdentities.map(identity => (
            <Row
              key={identity.id}
              label={<span className="flex min-w-0 items-center gap-2"><Link2 aria-hidden className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{identity.email ?? hostOf(identity.issuer)}</span></span>}
              description={`Connected ${formatDate(identity.createdAt)}${identity.lastUsedAt ? ` · last used ${formatRelative(identity.lastUsedAt)}` : ''}`}
            >
              <Button size="sm" variant="outline" onClick={() => setUnlinking(identity)}>Disconnect</Button>
            </Row>
          ))}
          <Separator />
        </>
      )}
      <h3 className="text-sm font-medium">Two-factor authentication</h3>
      {twoFactor ? (
        <Row
          label={(
            <span className="flex items-center gap-2">
              {twoFactor.enabled ? <ShieldCheck aria-hidden className="size-4 text-primary" /> : <ShieldOff aria-hidden className="size-4 text-muted-foreground" />}
              Authenticator app
              {twoFactor.enabled && <Badge tone="accent">On</Badge>}
            </span>
          )}
          description={twoFactor.enabled
            ? `On since ${formatDate(twoFactor.enabledAt!)} · ${plural(twoFactor.recoveryCodesRemaining, 'recovery code')} left. Signing in with your password asks for a code from the app.`
            : security.hasPassword
              ? 'Ask for a code from an app such as 1Password, Google Authenticator or Authy after your password.'
              : 'It protects password sign-in, and your account has no password. Your single sign-on provider decides how you prove who you are.'}
        >
          {twoFactor.enabled ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setDialog('codes')}>New recovery codes</Button>
              <Button size="sm" variant="outline" onClick={() => setDialog('disable')}>Turn off</Button>
            </>
          ) : (
            security.hasPassword && <Button size="sm" variant="outline" onClick={() => setDialog('enable')}>Turn on</Button>
          )}
        </Row>
      ) : failures?.security ?? <Row label={<Skeleton className="h-5 w-40" />} description={<Skeleton className="mt-1 h-4 w-64 max-w-full" />} />}
      <p className="text-xs text-muted-foreground">App passwords for Subsonic apps don’t ask for a code: they are separate passwords, each for one app.</p>

      <Separator />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Passkeys</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Sign in with Face ID, Touch ID, Windows Hello or a security key instead of your password. A passkey doesn’t need an authenticator code.</p>
        </div>
        {passkeys.server && passkeys.browser && security && <Button size="sm" variant="outline" onClick={() => setDialog('passkey')}><Plus />Add passkey</Button>}
      </div>
      {!passkeys.server
        ? <p className="text-xs text-muted-foreground">Passkeys need this server’s public address to use HTTPS. Ask whoever runs it to set PUBLIC_URL.</p>
        : !passkeys.browser && <p className="text-xs text-muted-foreground">This browser can’t make passkeys.</p>}
      {security?.passkeys.length === 0 && passkeys.server && <p className="text-xs text-muted-foreground">No passkeys yet.</p>}
      {!!security?.passkeys.length && (
        <ul aria-label="Passkeys" className="flex flex-col gap-4">
          {security.passkeys.map(passkey => (
            <li key={passkey.id}>
              <Row
                label={<span className="flex min-w-0 items-center gap-2"><KeyRound aria-hidden className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{passkey.name}</span>{passkey.backedUp && <Badge tone="outline">Synced</Badge>}</span>}
                description={`Added ${formatDate(passkey.createdAt)} · ${passkey.lastUsedAt ? `last used ${formatRelative(passkey.lastUsedAt)}` : 'not used yet'}`}
              >
                <Button size="sm" variant="outline" onClick={() => setRenaming(passkey)}>Rename</Button>
                <Button size="sm" variant="outline" onClick={() => setRemoving(passkey)}>Remove</Button>
              </Row>
            </li>
          ))}
        </ul>
      )}

      <Separator />
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Where you’re signed in</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">Browsers and apps signed in to your account. Sign one out if you don’t recognize it, then change your password.</p>
        </div>
        {others > 0 && <Button size="sm" variant="outline" pending={othersPending} onClick={() => void signOutOthers()}>Sign out everywhere else</Button>}
      </div>
      <FormError message={othersError} />
      {sessions
        ? <SessionList sessions={sessions} onRevoke={session => onRevokeSession(session.id)} />
        : failures?.sessions ?? <Row label={<Skeleton className="h-5 w-40" />} description={<Skeleton className="mt-1 h-4 w-64 max-w-full" />} />}

      <AddPasskeyDialog open={dialog === 'passkey'} onOpenChange={close} defaultName={defaultPasskeyName} hasPassword={hasPassword} onAdd={onAddPasskey} />
      {sso && <LinkSsoDialog open={dialog === 'sso'} onOpenChange={close} name={sso.name} hasPassword={hasPassword} onLink={onLinkSso} />}
      <ConfirmDialog
        open={!!unlinking}
        onOpenChange={open => { if (!open) setUnlinking(null) }}
        title={`Disconnect ${sso?.name ?? 'single sign-on'}?`}
        description="You can’t sign in with it any more until you connect it again."
        confirmLabel="Disconnect"
        onConfirm={() => onUnlinkSso(unlinking!.id)}
      />
      {renaming && <RenamePasskeyDialog passkey={renaming} onOpenChange={open => { if (!open) setRenaming(null) }} onRename={name => onRenamePasskey(renaming.id, name)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={open => { if (!open) setRemoving(null) }}
        title={`Remove “${removing?.name}”?`}
        description="It can’t sign in to this server any more. Your password manager may still show it; you can delete it there too."
        confirmLabel="Remove"
        onConfirm={() => onDeletePasskey(removing!.id)}
      />
      <EnableTwoFactorDialog open={dialog === 'enable'} onOpenChange={close} onStart={onStartTwoFactor} onEnable={onEnableTwoFactor} />
      <ConfirmTwoFactorDialog
        open={dialog === 'disable'}
        onOpenChange={close}
        title="Turn off two-factor authentication?"
        description="Signing in will take only your password. Your recovery codes stop working."
        submitLabel="Turn off"
        onConfirm={async request => { await onDisableTwoFactor(request); return null }}
      />
      <ConfirmTwoFactorDialog
        open={dialog === 'codes'}
        onOpenChange={close}
        title="New recovery codes"
        description="Your old recovery codes stop working, and you get ten new ones."
        submitLabel="Make new codes"
        onConfirm={async request => (await onRegenerateRecoveryCodes(request)).recoveryCodes}
      />
    </>
  )
}

/** The recovery codes, shown once, with a way to copy them all. */
export function RecoveryCodeList({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Recovery codes" className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg border bg-muted/40 px-4 py-3 font-mono text-sm">
        {codes.map(code => <li key={code}>{code}</li>)}
      </ul>
      <Button
        variant="outline"
        className="self-start"
        onClick={() => void navigator.clipboard.writeText(codes.join('\n')).then(() => setCopied(true), () => {})}
      >
        {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy all'}
      </Button>
    </div>
  )
}

/** Groups the secret in fours, as authenticator apps print it, so it can be typed in. */
const groupSecret = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret

type EnableStep = { step: 'password' } | { step: 'scan'; setup: TwoFactorSetup } | { step: 'codes'; codes: string[] }

function EnableTwoFactorDialog({ open, onOpenChange, onStart, onEnable }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onStart: SecuritySettingsProps['onStartTwoFactor']
  onEnable: SecuritySettingsProps['onEnableTwoFactor']
}) {
  const [state, setState] = useState<EnableStep>({ step: 'password' })
  const [currentPassword, setCurrentPassword] = useState('')
  const [code, setCode] = useState('')
  const start = useFormSubmit(StartTwoFactorRequest, async request => setState({ step: 'scan', setup: await onStart(request) }), { invalid_credentials: 'currentPassword' })
  const enable = useFormSubmit(EnableTwoFactorRequest, async request => setState({ step: 'codes', codes: (await onEnable(request)).recoveryCodes }), { invalid_code: 'code' })
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setState({ step: 'password' })
      setCurrentPassword('')
      setCode('')
      start.reset()
      enable.reset()
    }
  }
  const content = state.step === 'password'
    ? { title: 'Turn on two-factor authentication', description: 'Enter your password to start.' }
    : state.step === 'scan'
      ? { title: 'Scan the code', description: 'Scan it with your authenticator app, then enter the 6-digit code the app shows.' }
      : { title: 'Save your recovery codes', description: 'Two-factor authentication is on. Each code signs you in once if you lose your phone. Keep them somewhere safe: this is the only time they are shown.' }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={content.title} description={content.description}>
        {state.step === 'password' && (
          <form onSubmit={(event: FormEvent) => { event.preventDefault(); void start.submit({ currentPassword }) }} className="flex flex-col gap-4" noValidate>
            <Field label="Your password" htmlFor="two-factor-password" error={start.errors.currentPassword}>
              <Input id="two-factor-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} aria-invalid={!!start.errors.currentPassword} autoFocus />
            </Field>
            <FormError message={start.errors.form} />
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button type="submit" variant="primary" pending={start.pending} disabled={!currentPassword}>Continue</Button>
            </DialogFooter>
          </form>
        )}
        {state.step === 'scan' && (
          <form onSubmit={(event: FormEvent) => { event.preventDefault(); void enable.submit({ code }) }} className="flex flex-col gap-4" noValidate>
            {/* White behind the code whatever the theme: scanners need dark on light. */}
            <img src={state.setup.qrCode} alt="QR code for your authenticator app" className="mx-auto size-48 rounded-lg bg-white p-2" />
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">Can’t scan it? Enter this key in the app instead.</span>
              <CopyField value={groupSecret(state.setup.secret)} label="Setup key" />
            </div>
            <Field label="Code from the app" htmlFor="two-factor-code" error={enable.errors.code}>
              <Input id="two-factor-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} className="font-mono tracking-widest" value={code} onChange={event => setCode(event.target.value)} aria-invalid={!!enable.errors.code} autoFocus />
            </Field>
            <FormError message={enable.errors.form} />
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button type="submit" variant="primary" pending={enable.pending} disabled={!code.trim()}>Turn on</Button>
            </DialogFooter>
          </form>
        )}
        {state.step === 'codes' && (
          <div className="flex flex-col gap-4">
            <RecoveryCodeList codes={state.codes} />
            <DialogFooter><DialogClose asChild><Button variant="primary">I’ve saved them</Button></DialogClose></DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Password and a current code: turning two-factor off, or replacing the recovery codes. */
function ConfirmTwoFactorDialog({ open, onOpenChange, title, description, submitLabel, onConfirm }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  submitLabel: string
  /** Resolves with new recovery codes to show, or null to close. */
  onConfirm: (request: ConfirmTwoFactorRequest) => Promise<string[] | null>
}) {
  const [value, setValue] = useState({ currentPassword: '', code: '' })
  const [codes, setCodes] = useState<string[] | null>(null)
  const clear = () => {
    setValue({ currentPassword: '', code: '' })
    setCodes(null)
  }
  const form = useFormSubmit(ConfirmTwoFactorRequest, async request => {
    const shown = await onConfirm(request)
    if (shown) return setCodes(shown)
    clear()
    onOpenChange(false)
  }, { invalid_credentials: 'currentPassword', invalid_code: 'code' })
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      clear()
      form.reset()
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={codes ? 'Save your recovery codes' : title} description={codes ? 'This is the only time they are shown. Each one signs you in once.' : description}>
        {codes ? (
          <div className="flex flex-col gap-4">
            <RecoveryCodeList codes={codes} />
            <DialogFooter><DialogClose asChild><Button variant="primary">I’ve saved them</Button></DialogClose></DialogFooter>
          </div>
        ) : (
          <form onSubmit={(event: FormEvent) => { event.preventDefault(); void form.submit(value) }} className="flex flex-col gap-4" noValidate>
            <Field label="Your password" htmlFor="confirm-two-factor-password" error={form.errors.currentPassword}>
              <Input id="confirm-two-factor-password" type="password" autoComplete="current-password" value={value.currentPassword} onChange={event => setValue(current => ({ ...current, currentPassword: event.target.value }))} aria-invalid={!!form.errors.currentPassword} autoFocus />
            </Field>
            <Field label="Code from your authenticator app, or a recovery code" htmlFor="confirm-two-factor-code" error={form.errors.code}>
              <Input id="confirm-two-factor-code" autoComplete="one-time-code" autoCapitalize="none" spellCheck={false} className="font-mono" value={value.code} onChange={event => setValue(current => ({ ...current, code: event.target.value }))} aria-invalid={!!form.errors.code} />
            </Field>
            <FormError message={form.errors.form} />
            <DialogFooter>
              <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
              <Button type="submit" variant="danger" pending={form.pending} disabled={!value.currentPassword || !value.code.trim()}>{submitLabel}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

const AddPasskeyForm = StartPasskeyRequest.extend({ name: PasskeyName })

const hostOf = (issuer: string) => { try { return new URL(issuer).host } catch { return issuer } }

/** The password, then the browser's own passkey prompt. */
function AddPasskeyDialog({ open, onOpenChange, defaultName, hasPassword, onAdd }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultName: string
  /** Without a password, a recent sign-in stands in for it. */
  hasPassword: boolean
  onAdd: SecuritySettingsProps['onAddPasskey']
}) {
  const [value, setValue] = useState({ currentPassword: '', name: defaultName })
  const clear = () => setValue({ currentPassword: '', name: defaultName })
  const form = useFormSubmit(AddPasskeyForm, async request => {
    await onAdd({ name: request.name, currentPassword: hasPassword ? request.currentPassword : undefined })
    clear()
    onOpenChange(false)
  }, { invalid_credentials: 'currentPassword' })
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      clear()
      form.reset()
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Add a passkey" description={hasPassword ? 'Enter your password, then follow your browser’s prompt. The passkey is kept by your device or password manager.' : 'Follow your browser’s prompt. The passkey is kept by your device or password manager.'}>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void form.submit(hasPassword ? value : { name: value.name }) }} className="flex flex-col gap-4" noValidate>
          {hasPassword && (
            <Field label="Your password" htmlFor="passkey-password" error={form.errors.currentPassword}>
              <Input id="passkey-password" type="password" autoComplete="current-password" value={value.currentPassword} onChange={event => setValue(current => ({ ...current, currentPassword: event.target.value }))} aria-invalid={!!form.errors.currentPassword} autoFocus />
            </Field>
          )}
          <Field label="Name" htmlFor="passkey-name" error={form.errors.name} hint="So you can tell your passkeys apart.">
            <Input id="passkey-name" value={value.name} maxLength={60} onChange={event => setValue(current => ({ ...current, name: event.target.value }))} aria-invalid={!!form.errors.name} />
          </Field>
          <FormError message={form.errors.form} />
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" pending={form.pending} disabled={(hasPassword && !value.currentPassword) || !value.name.trim()}>Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RenamePasskeyDialog({ passkey, onOpenChange, onRename }: { passkey: Passkey; onOpenChange: (open: boolean) => void; onRename: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(passkey.name)
  const form = useFormSubmit(z.object({ name: PasskeyName }), async request => {
    await onRename(request.name)
    onOpenChange(false)
  })
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Rename passkey">
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void form.submit({ name }) }} className="flex flex-col gap-4" noValidate>
          <Field label="Name" htmlFor="rename-passkey" error={form.errors.name}>
            <Input id="rename-passkey" value={name} maxLength={60} onChange={event => setName(event.target.value)} aria-invalid={!!form.errors.name} autoFocus />
          </Field>
          <FormError message={form.errors.form} />
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" pending={form.pending} disabled={!name.trim()}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The password (when the account has one), then off to the provider, which sends the browser back here. */
function LinkSsoDialog({ open, onOpenChange, name, hasPassword, onLink }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  hasPassword: boolean
  onLink: SecuritySettingsProps['onLinkSso']
}) {
  const [currentPassword, setCurrentPassword] = useState('')
  const form = useFormSubmit(LinkSsoRequest, onLink, { invalid_credentials: 'currentPassword' })
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setCurrentPassword('')
      form.reset()
    }
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={`Connect ${name}`} description={`You’ll sign in at ${name} and come back here. Then you can sign in with it.`}>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void form.submit(hasPassword ? { currentPassword } : {}) }} className="flex flex-col gap-4" noValidate>
          {hasPassword && (
            <Field label="Your password" htmlFor="sso-password" error={form.errors.currentPassword}>
              <Input id="sso-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} aria-invalid={!!form.errors.currentPassword} autoFocus />
            </Field>
          )}
          <FormError message={form.errors.form} />
          <DialogFooter>
            <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" pending={form.pending} disabled={hasPassword && !currentPassword}>Continue</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
