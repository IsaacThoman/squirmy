import type { DeviceInfo } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { browserTab, deviceLabel, idleHint, listedDevices, playingOnText } from './devices.js'

const now = 1_800_000_000_000
const mac = '0b6f3c1e-8f2a-4c1d-9e7b-2a5d6c7e8f90'
const office = '7d2e9a40-1b3c-4d5e-8f60-718293a4b5c6'
const web = (id: string, extra: Partial<DeviceInfo> = {}): DeviceInfo => ({ id, name: 'Chrome on macOS', kind: 'web', canPlay: true, isActive: false, lastSeenAt: now, ...extra })
const phone: DeviceInfo = { id: 'phone', name: 'iPhone', kind: 'ios', canPlay: true, isActive: false, lastSeenAt: now }

describe('browserTab', () => {
  it('reads the browser and tab from a web device id', () => {
    expect(browserTab(web(mac))).toEqual({ browserId: mac, tab: 1 })
    expect(browserTab(web(`${mac}-3`))).toEqual({ browserId: mac, tab: 3 })
    expect(browserTab(phone)).toBeNull()
    expect(browserTab(web('kitchen'))).toBeNull()
  })
})

describe('listedDevices', () => {
  it('shows a browser once, as its playing tab, else the one seen last', () => {
    const devices = [web(mac), web(`${mac}-2`, { isActive: true }), web(`${mac}-3`), phone]
    expect(listedDevices(devices, 'phone').map(device => device.id)).toEqual([`${mac}-2`, 'phone'])
    const quiet = [web(mac, { lastSeenAt: now - 60_000 }), web(`${mac}-2`), phone]
    expect(listedDevices(quiet, 'phone').map(device => device.id)).toEqual([`${mac}-2`, 'phone'])
  })

  it('keeps this tab apart from the other tabs of its browser, folded into one', () => {
    const devices = [web(mac), web(`${mac}-2`), web(`${mac}-3`), phone]
    expect(listedDevices(devices, `${mac}-2`).map(device => device.id)).toEqual([mac, `${mac}-2`, 'phone'])
  })

  it('never folds detached tabs, which each play their own queue', () => {
    const detached = { playing: true, trackId: null, albumId: null }
    const devices = [web(mac, { detached }), web(`${mac}-2`, { detached })]
    expect(listedDevices(devices, 'phone')).toHaveLength(2)
  })
})

describe('deviceLabel', () => {
  it('names this device and the other tabs of its browser', () => {
    const devices = listedDevices([web(mac), web(`${mac}-2`), phone], mac)
    expect(deviceLabel(devices[0]!, devices, mac, 'This browser', now)).toEqual({ name: 'This browser', relation: 'this', hint: '' })
    expect(deviceLabel(devices[1]!, devices, mac, 'This browser', now)).toEqual({ name: 'Another tab', relation: 'tab', hint: '' })
    expect(deviceLabel(devices[2]!, devices, mac, 'This browser', now)).toEqual({ name: 'iPhone', relation: 'other', hint: '' })
  })

  it('tells apart two browsers of the same name by a piece of their id, only when their activity does not', () => {
    const same = [web(mac), web(office), phone]
    expect(same.slice(0, 2).map(device => deviceLabel(device, same, 'phone', 'This iPhone', now).hint)).toEqual(['ID 0b6f', 'ID 7d2e'])
    const apart = [web(mac), web(office, { lastSeenAt: now - 3 * 3_600_000 }), phone]
    expect(apart.slice(0, 2).map(device => deviceLabel(device, apart, 'phone', 'This iPhone', now).hint)).toEqual(['', ''])
  })

  it('drops the tab number older web clients put in the name', () => {
    const devices = [web(`${mac}-2`, { name: 'Chrome on macOS (2)' }), phone]
    expect(deviceLabel(devices[0]!, devices, 'phone', 'This iPhone', now).name).toBe('Chrome on macOS')
  })
})

describe('idleHint and playingOnText', () => {
  it('says how long a device has been quiet', () => {
    expect(idleHint(now - 60_000, now)).toBe('')
    expect(idleHint(now - 20 * 60_000, now)).toBe('Active 20 min ago')
    expect(idleHint(now - 3 * 3_600_000, now)).toBe('Active 3 h ago')
    expect(idleHint(now - 3 * 86_400_000, now)).toBe('Active 3 days ago')
    expect(idleHint(undefined, now)).toBe('')
  })

  it('says where it plays', () => {
    expect(playingOnText({ name: 'Kitchen', relation: 'other' })).toBe('Playing on Kitchen')
    expect(playingOnText({ name: 'Another tab', relation: 'tab' })).toBe('Playing in another tab')
  })
})
