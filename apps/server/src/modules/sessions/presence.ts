import type { ClientDevice, DeviceInfo } from '@squirmy/contracts'

/**
 * Which of a user's devices are connected right now, and through which sockets. A device
 * can have several sockets (two tabs of the web app); it is listed until the last closes.
 */

type PresentDevice = ClientDevice & { canPlay: boolean; sockets: Set<string> }

const presence = new Map<string, Map<string, PresentDevice>>()

/** Adds a socket to a device, creating or renaming the device. */
export function joinDevice(userId: string, socketId: string, device: ClientDevice, canPlay: boolean): void {
  const devices = presence.get(userId) ?? new Map<string, PresentDevice>()
  presence.set(userId, devices)
  const present = devices.get(device.id)
  devices.set(device.id, { ...device, canPlay, sockets: new Set([...(present?.sockets ?? []), socketId]) })
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

/** Ids of the user's connected devices, in the order they connected. */
export function connectedDeviceIds(userId: string): string[] {
  return [...(presence.get(userId)?.keys() ?? [])]
}

/**
 * Connected devices in the order they connected. `detached` gives what a detached device
 * plays on its own; such a device is listed as one the shared session cannot move to.
 */
export function listDevices(
  userId: string,
  activeDeviceId: string | null,
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
      ...(own ? { detached: own } : {}),
    }
  })
}
