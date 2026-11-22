import type { ClientDevice, DeviceInfo } from '@squirmy/contracts'

/**
 * Which of a user's devices are connected right now, and through which sockets. A device
 * can have several sockets (two tabs of the web app); it is listed until the last closes.
 */

/**
 * `lastSeenAt`: when the device last said anything (its hello, a command, a report).
 * `listedSeenAt`: the value the user's devices were last sent, so a device that keeps
 * reporting is sent again only every `SEEN_STEP_MS`.
 */
type PresentDevice = ClientDevice & { canPlay: boolean; sockets: Set<string>; lastSeenAt: number; listedSeenAt: number }

/** How far `lastSeenAt` may run ahead of what the other devices were sent. Clients show it to the minute. */
export const SEEN_STEP_MS = 60_000

const presence = new Map<string, Map<string, PresentDevice>>()

/** Adds a socket to a device, creating or renaming the device, and marks it seen at `now`. */
export function joinDevice(userId: string, socketId: string, device: ClientDevice, canPlay: boolean, now: number): void {
  const devices = presence.get(userId) ?? new Map<string, PresentDevice>()
  presence.set(userId, devices)
  const present = devices.get(device.id)
  devices.set(device.id, { ...device, canPlay, sockets: new Set([...(present?.sockets ?? []), socketId]), lastSeenAt: now, listedSeenAt: now })
}

/**
 * Marks a connected device seen at `now`. True when the device list should be sent again:
 * what the other devices were last sent is `SEEN_STEP_MS` or more behind.
 */
export function seeDevice(userId: string, deviceId: string, now: number): boolean {
  const present = presence.get(userId)?.get(deviceId)
  if (!present) return false
  present.lastSeenAt = Math.max(present.lastSeenAt, now)
  if (present.lastSeenAt - present.listedSeenAt < SEEN_STEP_MS) return false
  present.listedSeenAt = present.lastSeenAt
  return true
}

/** Removes a socket from a device. Returns true when that was the device's last socket. */
export function leaveDevice(userId: string, socketId: string, deviceId: string): boolean {
  const devices = presence.get(userId)
  const present = devices?.get(deviceId)
  if (!devices || !present?.sockets.delete(socketId)) return false
  if (present.sockets.size) return false
  devices.delete(deviceId)
  if (!devices.size) presence.delete(userId)
  return true
}

/** The device, while at least one of its sockets is connected. */
export function connectedDevice(userId: string, deviceId: string): PresentDevice | undefined {
  return presence.get(userId)?.get(deviceId)
}

/** The ids of the device's connected sockets. */
export function deviceSockets(userId: string, deviceId: string): string[] {
  return [...(presence.get(userId)?.get(deviceId)?.sockets ?? [])]
}

/** The device each of the user's connected sockets speaks for, by socket id. */
export function socketDevices(userId: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const device of presence.get(userId)?.values() ?? []) {
    for (const socketId of device.sockets) result.set(socketId, device.id)
  }
  return result
}

/** Ids of the user's connected devices, in the order they connected. */
export function connectedDeviceIds(userId: string): string[] {
  return [...(presence.get(userId)?.keys() ?? [])]
}

/**
 * Connected devices in the order they connected, as `currentDeviceId` (the device the list
 * is for, if any) sees them. `detached` gives what a detached device plays on its own;
 * such a device is listed as one the shared session cannot move to.
 */
export function listDevices(
  userId: string,
  activeDeviceId: string | null,
  currentDeviceId: string | null,
  detached: (deviceId: string) => DeviceInfo['detached'] = () => undefined,
): DeviceInfo[] {
  return [...(presence.get(userId)?.values() ?? [])].map((device) => {
    const own = detached(device.id)
    return {
      id: device.id,
      name: device.name,
      kind: device.kind,
      canPlay: device.canPlay && !own,
      isActive: device.id === activeDeviceId,
      isCurrent: device.id === currentDeviceId,
      lastSeenAt: device.lastSeenAt,
      ...(own ? { detached: own } : {}),
    }
  })
}
