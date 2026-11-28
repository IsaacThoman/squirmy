import type { JamInfo, QueueEntry, SessionCommand } from '@squirmy/contracts'
import { positionAt, type Session } from './reducer.js'

/**
 * What listening together does to sessions (see "Listen together" in the session contract).
 * The server runs these; they are here, next to the reducer, because they are the same kind
 * of pure arithmetic as detaching, and the clients' fake servers need them too.
 */

/** A listener's `trackEnded` this close to the end of the jam's current entry moves the jam on. */
export const JAM_END_SLACK_MS = 3000

/** The member's copy of the host's jam, memoized so an unchanged jam keeps its identity. */
const memberCopies = new WeakMap<JamInfo, JamInfo>()

export function memberJam(jam: JamInfo): JamInfo {
  if (jam.role === 'member') return jam
  let copy = memberCopies.get(jam)
  if (!copy) memberCopies.set(jam, copy = { ...jam, role: 'member' })
  return copy
}

/** The session follows someone else's jam. */
export function followsJam(session: Pick<Session, 'jam'>): boolean {
  return session.jam?.role === 'member'
}

/**
 * A member's session following the host's: everything the host's holds, keeping what is the
 * member's own (active device and volumes). A sleep timer is the host's, which pauses the jam,
 * so the member's copy has none. Returns `member` itself when nothing would change, so callers
 * can tell a no-op by identity.
 */
export function followJam(member: Session, host: Session): Session {
  if (!host.jam) return member
  const { sleepTimer: _sleepTimer, ...rest } = host
  const next: Session = { ...rest, activeDeviceId: member.activeDeviceId, volumes: member.volumes, jam: memberJam(host.jam) }
  const keys = new Set([...Object.keys(member), ...Object.keys(next)]) as Set<keyof Session>
  for (const key of keys) {
    if (member[key] !== next[key]) return next
  }
  return member
}

/** The session without its jam, as it is otherwise: what a device detaching from it takes along. */
export function withoutJam(session: Session): Session {
  if (!session.jam) return session
  const { jam: _jam, ...rest } = session
  return rest
}

/**
 * The session once it no longer takes part in a jam: a member's paused where the jam was at
 * `now`, with the queue kept; a host's goes on as it is, as their own session again.
 */
export function leaveJam(session: Session, now: number): Session {
  if (!session.jam) return session
  const { jam, ...rest } = session
  if (jam.role === 'host') return rest
  return { ...rest, playing: false, positionMs: positionAt(session, now), anchorAt: now }
}

/** Who added the entry, by name, while the session is in a jam. */
export function addedByName(session: Pick<Session, 'jam'>, entry: Pick<QueueEntry, 'addedBy'>): string | null {
  if (!session.jam || !entry.addedBy) return null
  return session.jam.members.find(member => member.userId === entry.addedBy)?.name ?? null
}

/**
 * What a member's command does while following a jam: `own`, applied to the member's own
 * session (their devices and volumes); `jam`, sent on to the host's session, subject to the
 * jam's rules; or the error it is refused with.
 */
export function memberCommandRoute(command: SessionCommand): 'own' | 'jam' | 'jam_host_only' | 'jam_unsupported' {
  switch (command.type) {
    case 'transfer':
    case 'setVolume':
      return 'own'
    case 'enqueue':
    case 'removeFromQueue':
    case 'trackEnded':
      return 'jam'
    case 'setSleepTimer':
      return 'jam_unsupported'
    default:
      return 'jam_host_only'
  }
}

/** Whether a member may send `command` on to the jam, as far as the client can tell: for disabling controls. */
export function memberMay(jam: JamInfo | undefined, command: SessionCommand['type']): boolean {
  if (!jam || jam.role === 'host') return true
  if (command === 'enqueue') return jam.queuePolicy === 'everyone'
  return command === 'transfer' || command === 'setVolume' || command === 'trackEnded' || command === 'removeFromQueue'
}
