import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'
import { REQUEST_NOT_ALLOWED, TrackRow, type NowPlaying } from './TrackList'

function renderRow(slug: string, props: { nowPlaying?: NowPlaying; canRequest?: boolean; isPreparing?: () => boolean } = {}) {
  const onPlay = vi.fn()
  const onAction = vi.fn()
  renderWithApp(<ul><TrackRow track={track(slug)} index={0} variant="album" onPlay={onPlay} onAction={onAction} {...props} /></ul>)
  return { onPlay, onAction, row: screen.getByRole('listitem') }
}

describe('TrackRow', () => {
  it('plays an owned track from its play button and on double click', async () => {
    const { onPlay, row } = renderRow('soft-signal')
    await userEvent.click(screen.getByRole('button', { name: 'Play Soft Signal' }))
    await userEvent.dblClick(row)
    expect(onPlay).toHaveBeenCalledTimes(2)
    expect(row).not.toHaveAttribute('aria-disabled')
  })

  it('grays out a track that is not in the library and cannot be played', async () => {
    const { onPlay, row } = renderRow('soft-signal-live')
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(within(row).queryByRole('button', { name: /^Play / })).toBeNull()
    expect(within(row).getByText('Soft Signal (Live)')).toHaveClass('text-quiet')
    expect(within(row).getByText('(not in your library)')).toBeInTheDocument()
    await userEvent.dblClick(row)
    expect(onPlay).not.toHaveBeenCalled()
  })

  it('marks an on-demand track but keeps it playable', () => {
    const { row } = renderRow('low-tide-song')
    expect(within(row).getByLabelText('Plays on demand')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Play Low Tide' })).toBeInTheDocument()
  })

  it('shows an on-demand track as unavailable, and why, to someone who may not fetch music', async () => {
    const { onPlay, row } = renderRow('low-tide-song', { canRequest: false })
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row).toHaveAttribute('title', REQUEST_NOT_ALLOWED)
    expect(within(row).queryByRole('button', { name: 'Play Low Tide' })).toBeNull()
    expect(within(row).queryByLabelText('Plays on demand')).toBeNull()
    await userEvent.click(within(row).getByRole('button', { name: 'More options for Low Tide' }))
    expect(await screen.findByText(REQUEST_NOT_ALLOWED, { selector: '[role=menu] *' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    await userEvent.dblClick(row)
    expect(onPlay).not.toHaveBeenCalled()
  })

  it('shows a track being fetched as preparing even when it is not playing', () => {
    const { row } = renderRow('low-tide-song', { isPreparing: () => true })
    expect(within(row).getByRole('status', { name: 'Preparing' })).toBeInTheDocument()
    expect(within(row).getByText('Preparing…')).toBeInTheDocument()
  })

  it('shows a spinner while the current track is preparing', () => {
    const id = track('night-swimming-demo').id
    const { row } = renderRow('night-swimming-demo', { nowPlaying: { trackId: id, playing: true, preparing: true, onTogglePlay: () => {} } })
    expect(within(row).getByRole('status', { name: 'Preparing' })).toBeInTheDocument()
    expect(within(row).getByText('Preparing…')).toBeInTheDocument()
  })

  it('marks the playing track and pauses it from its button', async () => {
    const onTogglePlay = vi.fn()
    const { row } = renderRow('night-swimming', { nowPlaying: { trackId: track('night-swimming').id, playing: true, preparing: false, onTogglePlay } })
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(within(row).getByRole('img', { name: 'Playing' })).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Pause Night Swimming' }))
    expect(onTogglePlay).toHaveBeenCalled()
  })

  it('shows the explicit badge and sends like actions', async () => {
    const { onAction } = renderRow('after-the-rain')
    expect(screen.getByTitle('Explicit')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save After the Rain to Liked Songs' }))
    expect(onAction).toHaveBeenCalledWith('like', track('after-the-rain'), 0)
  })
})
