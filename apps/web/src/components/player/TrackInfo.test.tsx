import type { SignalPath } from '@squirmy/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { track } from '@/fixtures/catalog'
import { devices, thisDeviceId } from '@/fixtures/server'
import type { Player, PlayerControls, PlayerState } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import { QualityBadge, TrackInfoDialog } from './TrackInfo'

const song = track('amber')

const hiRes: SignalPath = {
  entryId: 'e1',
  trackId: song.id,
  deviceId: 'living-room',
  source: { codec: 'flac', lossless: true, bitrate: 4_608_000, sampleRate: 96_000, bitDepth: 24, channels: 2, bytes: 52_428_800 },
  delivery: { profile: 'original', transcoded: false, codec: 'flac', lossless: true, bitrate: 4_608_000, sampleRate: 96_000, bitDepth: 24, reason: null, local: false },
  normalization: { mode: 'auto', applied: 'album', gainDb: -2.5 },
}

const transcoded: SignalPath = {
  ...hiRes,
  deviceId: thisDeviceId,
  delivery: { profile: 'aac_256', transcoded: true, codec: 'aac', lossless: false, bitrate: 256_000, sampleRate: 48_000, bitDepth: null, reason: 'codec', local: false },
}

function player(state: Partial<PlayerState>): Player {
  const value: PlayerState = {
    current: { track: song, entry: { id: 'e1', trackId: song.id, albumId: null, durationMs: song.durationMs, state: 'ready' } },
    playing: true, waiting: false, blocked: false, volume: 1, volumes: {}, shuffle: false, repeat: 'off', autoplay: false, context: null,
    queue: [], history: [], autoplayQueue: [], devices, thisDeviceId, activeDeviceId: thisDeviceId, away: null, lyrics: null,
    detached: false, canDetach: true,
    ...state,
  }
  return { state: value, controls: {} as PlayerControls }
}

function BadgeAndInfo({ value }: { value: Player }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <QualityBadge signal={value.state.signal} onOpen={() => setOpen(true)} />
      <TrackInfoDialog player={value} open={open} onOpenChange={setOpen} />
    </>
  )
}

describe('quality badge', () => {
  it('says Hi-Res Lossless or Lossless for a lossless stream, and nothing for a lossy one', () => {
    const { unmount } = renderWithApp(<QualityBadge signal={hiRes} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: 'Hi-Res Lossless, track info' })).toBeInTheDocument()
    unmount()
    const cd = { ...hiRes.delivery, sampleRate: 44_100, bitDepth: 16 }
    const second = renderWithApp(<QualityBadge signal={{ ...hiRes, delivery: cd }} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: 'Lossless, track info' })).toBeInTheDocument()
    second.unmount()
    // A lossless file transcoded on its way is not lossless where it plays.
    renderWithApp(<QualityBadge signal={transcoded} onOpen={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('track info', () => {
  it('opens from the badge with what the device playing it says, named as the devices list names it', async () => {
    renderWithApp(<BadgeAndInfo value={player({ activeDeviceId: 'living-room', signal: hiRes })} />)
    await userEvent.click(screen.getByRole('button', { name: 'Hi-Res Lossless, track info' }))
    const dialog = screen.getByRole('dialog', { name: 'Track info' })
    expect(within(dialog).getByText(song.title)).toBeInTheDocument()
    expect(within(dialog).getByText('Living Room')).toBeInTheDocument()
    expect(within(dialog).getByText('FLAC · Hi-Res Lossless')).toBeInTheDocument()
    expect(within(dialog).getByText('24-bit')).toBeInTheDocument()
    expect(within(dialog).getByText('96 kHz')).toBeInTheDocument()
    expect(within(dialog).getByText('50 MB')).toBeInTheDocument()
    expect(within(dialog).getByText('Original file')).toBeInTheDocument()
    expect(within(dialog).getByText('Album level, −2.5 dB')).toBeInTheDocument()
  })

  it('says a stream is a transcode, and why', () => {
    renderWithApp(<TrackInfoDialog player={player({ signal: transcoded })} open onOpenChange={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Track info' })
    expect(within(dialog).getByText('This browser')).toBeInTheDocument()
    expect(within(dialog).getByText('Transcoded to AAC 256 kbps')).toBeInTheDocument()
    expect(within(dialog).getByText('The device can’t play the original format')).toBeInTheDocument()
  })

  it('says so when the device playing did not report', () => {
    renderWithApp(<TrackInfoDialog player={player({ activeDeviceId: 'phone', signal: null })} open onOpenChange={() => {}} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('Alex’s iPhone hasn’t said how it plays this song. It may need an update.')
  })
})
