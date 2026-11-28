import type { JamInfo } from '@squirmy/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import { devices, thisDeviceId } from '@/fixtures/server'
import { PlayerContext, type Player, type PlayerControls, type PlayerState } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import { DeviceList } from './Devices'
import { ListenTogetherProvider } from './ListenTogether'
import { PlayerBar } from './PlayerBar'

const song = track('amber')
const HOST = '01900000-0000-7000-8000-0000000000a1'
const ME = '01900000-0000-7000-8000-0000000000a2'

function jam(role: JamInfo['role'], queuePolicy: JamInfo['queuePolicy'] = 'everyone'): JamInfo {
  return {
    id: 'abcdefghijklmnopqrstuv', hostUserId: role === 'host' ? ME : HOST, queuePolicy, startedAt: 0, role,
    members: role === 'host'
      ? [{ userId: ME, name: 'Alex Kim', joinedAt: 0 }, { userId: HOST, name: 'Robin', joinedAt: 1 }]
      : [{ userId: HOST, name: 'Robin', joinedAt: 0 }, { userId: ME, name: 'Alex Kim', joinedAt: 1 }],
  }
}

function setup(state: Partial<PlayerState>) {
  const controls = {
    jam: vi.fn<PlayerControls['jam']>(async () => ({ ok: true, jam: null })),
    dismissJamInvite: vi.fn(),
    transfer: vi.fn(),
    setVolume: vi.fn(),
    tell: vi.fn(),
  }
  const value: PlayerState = {
    current: { track: song, entry: { id: 'e1', trackId: song.id, albumId: null, durationMs: song.durationMs, state: 'ready' } },
    playing: true, waiting: false, blocked: false, volume: 1, volumes: {}, shuffle: false, repeat: 'off', autoplay: false, context: null,
    queue: [], history: [], autoplayQueue: [], devices, thisDeviceId, activeDeviceId: thisDeviceId, away: null, lyrics: null,
    detached: false, canDetach: true, canJam: true,
    ...state,
  }
  const player = { state: value, controls: controls as unknown as PlayerControls } satisfies Player
  return { player, controls }
}

function renderPicker(player: Player) {
  return renderWithApp(<PlayerContext value={player}><ListenTogetherProvider><DeviceList player={player} /></ListenTogetherProvider></PlayerContext>)
}

describe('listen together', () => {
  it('is offered in the device picker only where the server can', () => {
    const { unmount } = renderPicker(setup({ canJam: false }).player)
    expect(screen.queryByRole('button', { name: /Listen together/ })).toBeNull()
    unmount()
    renderPicker(setup({}).player)
    expect(screen.getByRole('button', { name: /Listen together/ })).toBeInTheDocument()
  })

  it('starts a listening session from the picker', async () => {
    const { player, controls } = setup({})
    renderPicker(player)
    await userEvent.click(screen.getByRole('button', { name: /Listen together/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Listen together' })
    await userEvent.click(within(dialog).getByRole('button', { name: /Start listening together/ }))
    expect(controls.jam).toHaveBeenCalledWith({ action: 'start' })
  })

  it('shows the host who is listening, the link, whom to invite and who adds songs', async () => {
    const { player, controls } = setup({ jam: jam('host') })
    renderPicker(player)
    await userEvent.click(screen.getByRole('button', { name: /Listening together/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Listening together' })
    expect(within(dialog).getByRole('textbox', { name: 'Invite link' })).toHaveValue(`${window.location.origin}/jam/abcdefghijklmnopqrstuv`)
    expect(within(dialog).getByText('Alex Kim')).toBeInTheDocument()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove Robin' }))
    expect(controls.jam).toHaveBeenCalledWith({ action: 'remove', userId: HOST })
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Invite' }))
    expect(controls.jam).toHaveBeenCalledWith({ action: 'invite', userIds: ['01900000-0000-7000-8000-0000000000f1'] })
    await userEvent.click(within(dialog).getByRole('button', { name: 'End for everyone' }))
    expect(controls.jam).toHaveBeenCalledWith({ action: 'end' })
  })

  it('lets a member leave, and leaves playback to the host', async () => {
    const { player, controls } = setup({ jam: jam('member', 'host') })
    renderWithApp(<PlayerContext value={player}><ListenTogetherProvider><PlayerBar player={player} liked={false} onToggleLike={() => {}} queueOpen={false} onToggleQueue={() => {}} lyricsOpen={false} onToggleLyrics={() => {}} onOpenNowPlaying={() => {}} /></ListenTogetherProvider></PlayerContext>)
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Listening together with 1 other' }))
    const dialog = await screen.findByRole('dialog', { name: 'Listening together' })
    expect(within(dialog).getByText('Only the host adds songs.')).toBeInTheDocument()
    expect(within(dialog).queryByRole('textbox', { name: 'Invite link' })).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave' }))
    expect(controls.jam).toHaveBeenCalledWith({ action: 'leave' })
  })

  it('asks before joining when invited', async () => {
    const { player, controls } = setup({ jamInvite: { jamId: 'abcdefghijklmnopqrstuv', hostName: 'Robin' } })
    renderPicker(player)
    const dialog = await screen.findByRole('dialog', { name: 'Robin invited you to listen together' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Join' }))
    expect(controls.jam).toHaveBeenCalledWith({ action: 'join', jamId: 'abcdefghijklmnopqrstuv' })
    expect(controls.dismissJamInvite).toHaveBeenCalled()
  })
})
