import type { DeviceInfo } from '@squirmy/contracts'

/**
 * Devices and tabs.
 *
 * A **device** is one install of a client: the iPhone app, or one browser profile (the web
 * app keeps its id in local storage). Its name is the one the user gave it, or one made
 * from the browser and OS ("Chrome on macOS").
 *
 * A **tab** is a second (third…) web page of the same browser. Each tab must be its own
 * player, or every open tab would play while the browser is the active device, so tabs
 * after the first say hello as `<browser id>-<n>` under the browser's name. The tab number
 * is never part of a name: lists show the tabs of one browser as a single row
 * ({@link listedDevices}), and the tabs of the viewer's own browser as "Another tab".
 */

/** A web device id: the browser's UUID, then `-<n>` for its second tab on. */
const WEB_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-(\d+))?$/i

/** The browser a web device belongs to and which of its tabs it is; null for other devices. */
export function browserTab(device: Pick<DeviceInfo, 'id' | 'kind'>): { browserId: string; tab: number } | null {
  if (device.kind !== 'web') return null
  const match = WEB_ID.exec(device.id)
  if (!match) return null
  return { browserId: match[1]!.toLowerCase(), tab: match[2] ? Number(match[2]) : 1 }
}

/** The id of the first tab of `tab`'s browser ("<uuid>-3" gives "<uuid>"). */
export function webDeviceId(browserId: string, tab: number): string {
  return tab === 1 ? browserId : `${browserId}-${tab}`
}

/**
 * Older web clients put the tab number in the name ("Chrome on macOS (2)"); a list that
 * meets one shows the name without it.
 */
function plainName(device: DeviceInfo): string {
  const tab = browserTab(device)?.tab
  return tab && tab > 1 ? device.name.replace(new RegExp(` \\(${tab}\\)$`), '') : device.name
}

/**
 * Which of a browser's tabs stands for it in a list: the playing one, else the first. Not
 * the one seen last: every listed tab answers the server's heartbeat, which keeps their
 * `lastSeenAt` within moments of each other, so going by it would swap the row between lists.
 */
function rank(device: DeviceInfo): [number, number] {
  return [device.isActive ? 1 : 0, -(browserTab(device)?.tab ?? 1)]
}

function before(a: DeviceInfo, b: DeviceInfo): boolean {
  const [x, y] = [rank(a), rank(b)]
  for (let index = 0; index < x.length; index += 1) if (x[index] !== y[index]) return x[index]! > y[index]!
  return false
}

/**
 * The devices a picker lists, in the order given: one row per browser rather than per tab
 * (the playing tab, else the first). The viewer's own tab is kept, and its
 * browser's other tabs are kept apart from it as one "Another tab" row. Detached devices
 * play something of their own each, so they are never folded together.
 */
export function listedDevices(devices: readonly DeviceInfo[], thisDeviceId: string): DeviceInfo[] {
  const chosen = new Map<string, DeviceInfo>()
  const keyOf = (device: DeviceInfo) => {
    if (device.id === thisDeviceId || device.detached) return device.id
    const browser = browserTab(device)
    return browser ? `browser:${browser.browserId}` : device.id
  }
  for (const device of devices) {
    const key = keyOf(device)
    const held = chosen.get(key)
    if (!held || before(device, held)) chosen.set(key, device)
  }
  const kept = new Set(chosen.values())
  return devices.filter(device => kept.has(device))
}

export type DeviceLabel = {
  /** What the row is called. */
  name: string
  /** The viewer's own device, another tab of the viewer's browser, or any other device. */
  relation: 'this' | 'tab' | 'other'
  /**
   * "ID 4f2a" when another listed device has the same name and how long each has been
   * quiet ({@link idleHint}, which lists show anyway) does not tell them apart; else empty.
   */
  hint: string
}

/** "Active 3 h ago" for a device quiet for five minutes or more; empty for one in use, or from a server that does not say. */
export function idleHint(lastSeenAt: number | undefined, now = Date.now()): string {
  if (lastSeenAt === undefined) return ''
  const minutes = Math.floor((now - lastSeenAt) / 60_000)
  if (minutes < 5) return ''
  if (minutes < 60) return `Active ${minutes} min ago`
  if (minutes < 48 * 60) return `Active ${Math.floor(minutes / 60)} h ago`
  return `Active ${Math.floor(minutes / (24 * 60))} days ago`
}

/** A short, stable tag from the device id, for two devices nothing else tells apart. */
function shortId(device: DeviceInfo): string {
  const browser = browserTab(device)
  return (browser?.browserId ?? device.id).replace(/[^0-9a-z]/gi, '').slice(0, 4).toLowerCase()
}

/**
 * How a device is named in a list the viewer sees. `thisName` is what the viewer's own
 * device is called there ("This browser", "This iPhone"). Another tab of the viewer's
 * browser is "Another tab". Anything else keeps its name, and when another device in
 * `devices` has the same one and the same {@link idleHint}, the hint is a short piece of its
 * id (renaming one in Settings is the lasting fix). Pass the list {@link listedDevices} gave.
 */
export function deviceLabel(device: DeviceInfo, devices: readonly DeviceInfo[], thisDeviceId: string, thisName: string, now = Date.now()): DeviceLabel {
  if (device.id === thisDeviceId) return { name: thisName, relation: 'this', hint: '' }
  const browser = browserTab(device)
  const own = devices.find(other => other.id === thisDeviceId) ?? { id: thisDeviceId, kind: 'web' as const }
  const ownBrowser = browserTab(own)
  if (browser && ownBrowser && browser.browserId === ownBrowser.browserId) return { name: 'Another tab', relation: 'tab', hint: '' }
  const name = plainName(device)
  const twins = devices.filter(other => other.id !== device.id && other.id !== thisDeviceId && plainName(other) === name)
  if (!twins.length) return { name, relation: 'other', hint: '' }
  const idle = idleHint(device.lastSeenAt, now)
  if (twins.every(other => idleHint(other.lastSeenAt, now) !== idle)) return { name, relation: 'other', hint: '' }
  return { name, relation: 'other', hint: `ID ${shortId(device)}` }
}

/**
 * "Playing on Chrome on macOS", or "Playing in another tab". With `playing` false, "Paused on …":
 * the device still holds the session, and saying it plays beside a Play button contradicts it.
 */
export function playingOnText(label: Pick<DeviceLabel, 'name' | 'relation'>, playing = true): string {
  const verb = playing ? 'Playing' : 'Paused'
  return label.relation === 'tab' ? `${verb} in another tab` : `${verb} on ${label.name}`
}

/**
 * What a player says while the session waits for its active device to come back (the
 * client's `away`): "Reconnecting to Chrome on macOS…", "Reconnecting to another tab…", or,
 * for a device this client never saw listed, "Reconnecting to the playing device…".
 */
export function reconnectingText(label: Pick<DeviceLabel, 'name' | 'relation'> | null): string {
  if (!label) return 'Reconnecting to the playing device…'
  return label.relation === 'tab' ? 'Reconnecting to another tab…' : `Reconnecting to ${label.name}…`
}
