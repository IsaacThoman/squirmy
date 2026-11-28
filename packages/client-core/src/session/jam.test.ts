import type { JamInfo } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/client.js'
import { addedByName, followJam, leaveJam, memberCommandRoute, memberJam, sitOutNotice, withoutJam } from './jam.js'
import { createInitialSession, reduceSession, type Session } from './reducer.js'

const HOST = '01900000-0000-7000-8000-000000000001'
const GUEST = '01900000-0000-7000-8000-000000000002'
const TRACK = '01900000-0000-7000-8000-0000000000aa'

const jam: JamInfo = {
  id: 'abcdefghijklmnopqrstuv',
  hostUserId: HOST,
  members: [{ userId: HOST, name: 'Host', joinedAt: 1 }, { userId: GUEST, name: 'Guest', joinedAt: 2 }],
  queuePolicy: 'everyone',
  startedAt: 1,
  role: 'host',
}

function hostSession(): Session {
  const played = reduceSession(createInitialSession(), {
    command: { type: 'playTracks', tracks: [{ trackId: TRACK, durationMs: 200_000, addedBy: HOST }], seed: 1 },
    now: 1000,
    commandId: 'c1',
    deviceId: 'host-device',
  })
  return { ...played, jam, volumes: { 'host-device': 0.5 }, sleepTimer: { kind: 'track' } }
}

describe('listening together', () => {
  it('follows the host\'s session but keeps the member\'s own device and volumes', () => {
    const host = hostSession()
    const member: Session = { ...createInitialSession(), activeDeviceId: 'guest-device', volumes: { 'guest-device': 0.8 }, jam: memberJam(jam) }
    const followed = followJam(member, host)
    expect(followed).toMatchObject({ current: host.current, playing: true, anchorAt: 1000, activeDeviceId: 'guest-device', volumes: { 'guest-device': 0.8 } })
    expect(followed.jam).toEqual({ ...jam, role: 'member' })
    // The host's sleep timer pauses the jam; a member's copy has none of its own.
    expect(followed.sleepTimer).toBeUndefined()
    expect(followJam(followed, host)).toBe(followed)
  })

  it('pauses a member who leaves where the jam was, and lets a host carry on', () => {
    const host = hostSession()
    const member = followJam({ ...createInitialSession(), jam: memberJam(jam) }, host)
    const left = leaveJam(member, 31_000)
    expect(left).toMatchObject({ playing: false, positionMs: 30_000, anchorAt: 31_000, current: host.current })
    expect(left.jam).toBeUndefined()
    const ended = leaveJam(host, 31_000)
    expect(ended).toMatchObject({ playing: true, anchorAt: 1000 })
    expect(ended.jam).toBeUndefined()
    expect(withoutJam(member).playing).toBe(true)
  })

  it('keeps who added an entry, and names them while in the jam', () => {
    const host = hostSession()
    expect(host.current!.addedBy).toBe(HOST)
    expect(addedByName(host, host.current!)).toBe('Host')
    expect(addedByName(withoutJam(host), host.current!)).toBeNull()
  })

  it('leaves playback to the host', () => {
    expect(memberCommandRoute({ type: 'pause' })).toBe('jam_host_only')
    expect(memberCommandRoute({ type: 'enqueue', placement: 'next', tracks: [{ trackId: TRACK, durationMs: 0 }] })).toBe('jam')
    expect(memberCommandRoute({ type: 'transfer', deviceId: 'x' })).toBe('own')
    expect(memberCommandRoute({ type: 'setSleepTimer', timer: null })).toBe('jam_unsupported')
  })

  it('says why a member\'s device sits a song out, and that it joins in again', () => {
    expect(sitOutNotice('Curse', new ApiError(403, 'explicit_not_allowed', 'Explicit content is off for this account'))).toEqual({
      message: '“Curse” isn’t playing for you',
      detail: 'Explicit content is off for you. You’ll hear the next song with everyone.',
    })
    expect(sitOutNotice(undefined, new ApiError(404, 'not_found', 'Not found'))).toEqual({
      message: 'This song isn’t playing for you',
      detail: 'It can’t play here. You’ll hear the next song with everyone.',
    })
  })
})
