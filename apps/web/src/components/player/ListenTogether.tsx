import { queryKeys, type JamInfo, type JamMember, type JamQueuePolicy } from '@squirmy/contracts'
import { useQuery } from '@tanstack/react-query'
import { Crown, UserMinus, UserPlus, Users } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useApi } from '@/api/services'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { usePlayer, type Player } from '@/player/player-context'
import { JamDialogContext, jamError, jamLink, useOpenJam } from './listen-together'

/**
 * Listening together: the dialog the player opens to start, share and run a jam, and the one
 * that asks when someone invites this user. Wraps the shell, so the player bar and the device
 * picker can open it.
 */
export function ListenTogetherProvider({ children }: { children: ReactNode }) {
  const player = usePlayer()
  const [open, setOpen] = useState(false)
  return (
    <JamDialogContext value={() => setOpen(true)}>
      {children}
      {player.state.canJam && (
        <>
          <Dialog open={open} onOpenChange={setOpen}>
            {open && <JamDialog player={player} onClose={() => setOpen(false)} />}
          </Dialog>
          <JamInviteDialog player={player} onJoined={() => setOpen(true)} />
        </>
      )}
    </JamDialogContext>
  )
}

const POLICY_OPTIONS = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'host', label: 'Only me' },
] as const satisfies readonly { value: JamQueuePolicy; label: string }[]

function JamDialog({ player, onClose }: { player: Player; onClose: () => void }) {
  const { jam } = player.state
  if (!jam) return <StartJam player={player} onClose={onClose} />
  return <RunningJam player={player} jam={jam} onClose={onClose} />
}

function StartJam({ player, onClose }: { player: Player; onClose: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const start = async () => {
    setPending(true)
    const result = await player.controls.jam({ action: 'start' })
    setPending(false)
    if (!result.ok) setError(jamError(result))
  }
  return (
    <DialogContent title="Listen together" description="Invite people on this server to hear what you play, each on their own device, in step. You choose what plays.">
      {player.state.detached && <p className="text-sm text-muted-foreground">This tab plays separately. Rejoin your other devices to start a listening session.</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button variant="primary" pending={pending} disabled={player.state.detached} onClick={() => void start()}><Users />Start listening together</Button>
      </DialogFooter>
    </DialogContent>
  )
}

function RunningJam({ player, jam, onClose }: { player: Player; jam: JamInfo; onClose: () => void }) {
  const hosting = jam.role === 'host'
  const host = jam.members.find(member => member.userId === jam.hostUserId)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const send = async (request: Parameters<Player['controls']['jam']>[0], close = false) => {
    setPending(true)
    const result = await player.controls.jam(request)
    setPending(false)
    if (!result.ok) return setError(jamError(result))
    setError(null)
    if (close) onClose()
  }
  return (
    <DialogContent
      title="Listening together"
      description={hosting ? 'Everyone hears what you play. Share the link with people on this server.' : `You’re listening with ${host?.name ?? 'the host'}. They choose what plays.`}
    >
      <section aria-label="People listening">
        <ul className="flex flex-col gap-1">
          {jam.members.map(member => (
            <li key={member.userId} className="flex items-center gap-3 py-1">
              <MemberAvatar name={member.name} />
              <span className="min-w-0 flex-1 truncate text-sm">{member.name}</span>
              {member.userId === jam.hostUserId && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Crown aria-hidden className="size-3.5" />Host</span>}
              {hosting && member.userId !== jam.hostUserId && (
                <IconButton label={`Remove ${member.name}`} size="sm" disabled={pending} onClick={() => void send({ action: 'remove', userId: member.userId })}><UserMinus /></IconButton>
              )}
            </li>
          ))}
        </ul>
      </section>
      {hosting && <CopyField value={jamLink(jam.id)} label="Invite link" />}
      {hosting && <InvitePeople player={player} jam={jam} />}
      {hosting ? (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Who can add songs</span>
          <Select
            label="Who can add songs"
            size="sm"
            value={jam.queuePolicy}
            options={POLICY_OPTIONS}
            disabled={pending}
            onValueChange={queuePolicy => void send({ action: 'settings', queuePolicy })}
          />
        </label>
      ) : (
        <p className="text-sm text-muted-foreground">{jam.queuePolicy === 'everyone' ? 'Anything you play is added to the queue for everyone.' : 'Only the host adds songs.'}</p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <DialogClose asChild><Button variant="outline">Close</Button></DialogClose>
        {hosting
          ? <Button variant="danger" pending={pending} onClick={() => void send({ action: 'end' }, true)}>End for everyone</Button>
          : <Button variant="danger" pending={pending} onClick={() => void send({ action: 'leave' }, true)}>Leave</Button>}
      </DialogFooter>
    </DialogContent>
  )
}

/** The server's other people, to invite one by one: each gets an invite wherever they are signed in. */
function InvitePeople({ player, jam }: { player: Player; jam: JamInfo }) {
  const api = useApi()
  const people = useQuery({ queryKey: queryKeys.jamPeople(), queryFn: () => api.sessions.jamPeople() })
  const [invited, setInvited] = useState<ReadonlySet<string>>(new Set())
  const listed = new Set(jam.members.map(member => member.userId))
  const others = (people.data?.items ?? []).filter(person => !listed.has(person.userId))
  if (!others.length) return null
  return (
    <section aria-label="Invite people" className="flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Invite</p>
      <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {others.map(person => (
          <li key={person.userId} className="flex items-center gap-3 py-1">
            <MemberAvatar name={person.name} />
            <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={invited.has(person.userId)}
              onClick={async () => {
                const result = await player.controls.jam({ action: 'invite', userIds: [person.userId] })
                if (result.ok) setInvited(new Set([...invited, person.userId]))
              }}
            >
              {invited.has(person.userId) ? 'Invited' : <><UserPlus />Invite</>}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Asks whether to join when someone invites this user; joining replaces what this account plays. */
function JamInviteDialog({ player, onJoined }: { player: Player; onJoined: () => void }) {
  const invite = player.state.jamInvite
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const open = Boolean(invite) && player.state.jam?.id !== invite?.jamId
  const close = () => {
    setError(null)
    player.controls.dismissJamInvite()
  }
  return (
    <Dialog open={open} onOpenChange={next => !next && close()}>
      {invite && (
        <DialogContent title={`${invite.hostName} invited you to listen together`} description="You’ll hear what they play, in step, on this device.">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={close}>Not now</Button>
            <Button
              variant="primary"
              pending={pending}
              onClick={async () => {
                setPending(true)
                const result = await player.controls.jam({ action: 'join', jamId: invite.jamId })
                setPending(false)
                if (!result.ok) return setError(jamError(result))
                close()
                onJoined()
              }}
            >
              Join
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}

const AVATAR_TONES = ['bg-sky-600', 'bg-violet-600', 'bg-emerald-600', 'bg-amber-600', 'bg-rose-600', 'bg-teal-600', 'bg-indigo-600', 'bg-fuchsia-600']

/** A person's initials on a color of their own, the same everywhere. */
export function MemberAvatar({ name, className }: { name: string; className?: string }) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || '?'
  return (
    <span aria-hidden className={cn('flex size-7 shrink-0 select-none items-center justify-center rounded-full text-[11px] font-semibold text-white', AVATAR_TONES[hash % AVATAR_TONES.length], className)}>
      {initials}
    </span>
  )
}

/** The people in a jam as overlapping avatars, for a button that opens it. */
export function MemberStack({ members, max = 3 }: { members: readonly JamMember[]; max?: number }) {
  const shown = members.slice(0, max)
  const more = members.length - shown.length
  return (
    <span className="flex items-center -space-x-1.5">
      {shown.map(member => <MemberAvatar key={member.userId} name={member.name} className="size-5 text-[9px] ring-2 ring-sidebar" />)}
      {more > 0 && <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold ring-2 ring-sidebar">+{more}</span>}
    </span>
  )
}

/** The player bar's button while in a jam: who is listening, opening the dialog. */
export function JamButton({ player, className }: { player: Player; className?: string }) {
  const open = useOpenJam()
  const { jam } = player.state
  if (!jam || !open) return null
  const others = jam.members.length - 1
  return (
    <button
      type="button"
      onClick={open}
      aria-label={`Listening together with ${others} ${others === 1 ? 'other' : 'others'}`}
      className={cn('flex h-8 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-primary outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', className)}
    >
      <MemberStack members={jam.members} />
    </button>
  )
}

