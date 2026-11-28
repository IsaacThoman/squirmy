import { positionAt, reduceSession, type Session, withoutSleepTimer } from './reducer.js'

/**
 * What detaching and attaching do to sessions (see "Detaching" in the session contract).
 * The server runs these; they are here, next to the reducer, because they are the same
 * kind of pure arithmetic and the clients' fake servers need them too.
 */

/**
 * The session paused where it is at `now`, with no active device. A sleep timer is for the
 * playback it would have stopped, so it does not come along.
 */
function parked(session: Session, now: number): Session {
  return {
    ...withoutSleepTimer(session),
    playing: false,
    positionMs: positionAt(session, now),
    anchorAt: now,
    stalled: session.current?.state === 'preparing',
    activeDeviceId: null,
  }
}

/**
 * The session a device starts with when it detaches from `shared` at server time `now`.
 * The shared session's active device takes it exactly as it is, anchor included (its sleep
 * timer too), so its audio carries on without a gap. Any other device gets it paused where
 * it was, with no active device and no sleep timer: nothing plays there until that device
 * says so.
 */
export function forkSession(shared: Session, deviceId: string, now: number): Session {
  return shared.activeDeviceId === deviceId ? shared : parked(shared, now)
}

/**
 * The shared session once its active device `deviceId` has detached at `now`: paused where
 * it was, as after `deviceLost`, and without the sleep timer, which went with the device.
 * Unchanged when the device was not its active device.
 */
export function leftBehind(shared: Session, deviceId: string, input: { now: number; commandId: string }): Session {
  if (shared.activeDeviceId !== deviceId) return shared
  return withoutSleepTimer(reduceSession(shared, { command: { type: 'deviceLost', deviceId }, ...input }))
}

/**
 * The shared session after a detached device attaches and brings its own session along:
 * everything `own` holds, entry ids included, with the device as the active device, which
 * is what `transfer` to itself makes of it (unchanged, anchor and all, when it was already
 * playing there). Pass `deviceId` only for a device that can play; without it the result
 * is paused with no active device. Volumes are per device, so the shared session keeps
 * its own and takes only this device's.
 */
export function bringSession(shared: Session, own: Session, input: { now: number; commandId: string; deviceId?: string }): Session {
  const { now, commandId, deviceId } = input
  if (deviceId === undefined) return { ...parked(own, now), volumes: shared.volumes }
  const moved = reduceSession(own, { command: { type: 'transfer', deviceId }, now, commandId })
  const volume = own.volumes[deviceId]
  return { ...moved, volumes: volume === undefined ? shared.volumes : { ...shared.volumes, [deviceId]: volume } }
}
