import type { ClientDevice } from '@squirmy/contracts'

const storageKey = 'squirmy.deviceId'

/** "Firefox on macOS", from the user agent; good enough to tell a person's browsers apart. */
export function deviceName(userAgent: string): string {
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Firefox\//.test(userAgent) ? 'Firefox'
      : /Chrome\//.test(userAgent) ? 'Chrome'
        : /Safari\//.test(userAgent) ? 'Safari'
          : 'Browser'
  const os = /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Android/.test(userAgent) ? 'Android'
      : /Mac OS X/.test(userAgent) ? 'macOS'
        : /Windows/.test(userAgent) ? 'Windows'
          : /Linux/.test(userAgent) ? 'Linux'
            : null
  return os ? `${browser} on ${os}` : browser
}

/** This browser as a device of the user's, with an id kept across visits. */
export function webDevice(): ClientDevice {
  let id: string | null = null
  try {
    id = localStorage.getItem(storageKey)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(storageKey, id)
    }
  } catch {
    id ??= crypto.randomUUID()
  }
  return { id, name: deviceName(navigator.userAgent), kind: 'web' }
}
