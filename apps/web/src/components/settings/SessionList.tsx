import type { AuthSession, SignInMethod } from '@squirmy/contracts'
import { Globe, KeyRound, Laptop, Smartphone, Speaker, Tv, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/feedback'
import { Row } from '@/components/ui/section'
import { deviceName } from '@/lib/device'
import { formatDate, formatRelative } from '@/lib/format'

const kindIcons: Record<string, LucideIcon> = { web: Globe, ios: Smartphone, android: Smartphone, tv: Tv, desktop: Laptop, speaker: Speaker }
const kindNames: Record<string, string> = { web: 'Web browser', ios: 'iPhone or iPad', android: 'Android', tv: 'Apple TV', desktop: 'Desktop app', speaker: 'Squirmy speaker' }

const methodNames: Record<SignInMethod, string> = {
  password: 'with a password',
  two_factor: 'with a password and an authenticator code',
  recovery_code: 'with a recovery code',
  passkey: 'with a passkey',
  tv_pairing: 'by pairing an Apple TV',
  speaker_pairing: 'by pairing a speaker',
  sso: 'with single sign-on',
}

/** What a session is called: the device's own name, else one read from the browser, else its kind. */
function sessionName(session: AuthSession): string {
  if (session.deviceName) return session.deviceName
  if (session.clientKind === 'web' && session.userAgent) return deviceName(session.userAgent)
  return kindNames[session.clientKind] ?? 'An app'
}

function sessionDescription(session: AuthSession): string {
  const signedIn = `Signed in ${formatDate(session.createdAt)}${session.method ? ` ${methodNames[session.method]}` : ''}`
  return session.current ? signedIn : `Last active ${formatRelative(session.lastSeenAt)} · ${signedIn}`
}

type SessionListProps = {
  sessions: AuthSession[]
  /** Ends one session, after asking. Not offered for the current one, which signs out instead. */
  onRevoke: (session: AuthSession) => Promise<unknown>
  /** "This browser" for your own list; an admin's view of someone else has no current session. */
  currentLabel?: string
}

/** Signed-in browsers and apps, most recently used first, each with Sign out. */
export function SessionList({ sessions, onRevoke, currentLabel = 'This browser' }: SessionListProps) {
  const [revoking, setRevoking] = useState<AuthSession | null>(null)
  return (
    <>
      <ul aria-label="Signed-in devices" className="flex flex-col gap-4">
        {sessions.map(session => {
          const Icon = kindIcons[session.clientKind] ?? KeyRound
          return (
            <li key={session.id}>
              <Row
                label={(
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{sessionName(session)}</span>
                    {session.current && <Badge tone="accent">{currentLabel}</Badge>}
                  </span>
                )}
                description={sessionDescription(session)}
              >
                {!session.current && <Button size="sm" variant="outline" onClick={() => setRevoking(session)}>Sign out</Button>}
              </Row>
            </li>
          )
        })}
      </ul>
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={next => { if (!next) setRevoking(null) }}
        title={`Sign out ${revoking ? sessionName(revoking) : ''}?`}
        description="It has to sign in again to play anything. App passwords for Subsonic apps keep working."
        confirmLabel="Sign out"
        onConfirm={() => onRevoke(revoking!)}
      />
    </>
  )
}
