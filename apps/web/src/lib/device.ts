import type { ClientDevice } from '@squirmy/contracts'

const idKey = 'squirmy.deviceId'
const nameKey = 'squirmy.deviceName'

/** "Firefox on macOS", from the user agent: the default name, until the user gives the browser one in Settings. */
export function deviceName(userAgent: string): string {
  const browser = /Edg(A|iOS)?\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
      : /Firefox\/|FxiOS\//.test(userAgent) ? 'Firefox'
        : /Chrome\/|CriOS\//.test(userAgent) ? 'Chrome'
          : /Safari\//.test(userAgent) ? 'Safari'
            : 'Browser'
  const os = /iPhone/.test(userAgent) ? 'iPhone'
    : /iPad/.test(userAgent) ? 'iPad'
      : /Android/.test(userAgent) ? 'Android'
        : /CrOS/.test(userAgent) ? 'ChromeOS'
          : /Mac OS X/.test(userAgent) ? 'macOS'
            : /Windows/.test(userAgent) ? 'Windows'
              : /Linux/.test(userAgent) ? 'Linux'
                : null
  return os ? `${browser} on ${os}` : browser
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Private windows may refuse storage; the value then lasts for this page only.
  }
}

let fallbackId: string | null = null

/** The name this browser shows in device lists: the one set in Settings, or one from the user agent. */
export function browserName(): string {
  return read(nameKey) ?? deviceName(navigator.userAgent)
}

/** Saves the name set in Settings; null goes back to the user agent's. */
export function saveBrowserName(name: string | null) {
  write(nameKey, name?.trim() || null)
}

/** This browser as a device of the user's, with an id kept across visits. */
export function webDevice(): ClientDevice {
  let id = read(idKey)
  if (!id) {
    id = fallbackId ?? crypto.randomUUID()
    fallbackId = id
    write(idKey, id)
  }
  return { id, name: browserName(), kind: 'web' }
}

export type TabDevice = { device: ClientDevice; slot: number }

let claim: Promise<TabDevice> | null = null

/** A reloading tab's old page can hold its lock for a moment; the new page waits this long for it. */
const RELOAD_WAIT_MS = 1500

/** Takes the named lock and holds it until the page goes away. Resolves false when it is taken elsewhere. */
function hold(locks: LockManager, name: string, waitMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const options: LockOptions = waitMs ? { signal: AbortSignal.timeout(waitMs) } : { ifAvailable: true }
    locks.request(name, options, lock => {
      resolve(lock !== null)
      return lock ? new Promise<never>(() => {}) : undefined
    }).catch(() => resolve(false))
  })
}

/**
 * The device this tab plays as. Tabs of one browser would otherwise share an id, and every
 * one of them would play while the browser is the active device. So each tab holds a Web
 * Lock on its id until it closes, and a second tab takes the next free slot (`<id>-2`).
 * Every tab keeps the browser's name: lists fold a browser's tabs into one row and call
 * this browser's other tabs "Another tab" (client-core `devices.ts`), so no tab number is
 * ever shown. Slots are stable, so a reloaded tab comes back as the device it was and
 * keeps playing.
 */
export function claimTabDevice(): Promise<TabDevice> {
  if (claim) return claim
  const claiming: Promise<TabDevice> = (async () => {
    const base = webDevice()
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    if (!locks) return { device: base, slot: 1 }
    for (let slot = 1; ; slot += 1) {
      const id = slot === 1 ? base.id : `${base.id}-${slot}`
      if (await hold(locks, `squirmy.device.${id}`, slot === 1 ? RELOAD_WAIT_MS : 0)) {
        return { device: { ...base, id }, slot }
      }
    }
  })()
  // React's `use` reads a promise marked settled this way without suspending, so a page that
  // claimed its device before rendering does not stop at the splash screen first.
  void claiming.then(value => Object.assign(claiming, { status: 'fulfilled', value }), () => {})
  claim = claiming
  return claim
}
