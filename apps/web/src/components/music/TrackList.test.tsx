import type { TrackSummary } from '@squirmy/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import type { Viewer } from '@/lib/catalog'
import { OnDemandContext } from '@/player/on-demand-context'
import { renderWithApp } from '@/test/render'
import { TrackRow, type NowPlaying } from './TrackList'

const requester: Viewer = { role: 'member', canAcquire: true }
const member: Viewer = { role: 'member', canAcquire: false }

type RowOptions = { nowPlaying?: NowPlaying; viewer?: Viewer; wanted?: boolean; track?: TrackSummary }

function renderRow(slug: string, { viewer = requester, ...props }: RowOptions = {}) {
  const onPlay = vi.fn()
  const onAction = vi.fn()
  renderWithApp(
    <OnDemandContext value={{ viewer }}>
      <ul><TrackRow track={track(slug)} index={0} variant="album" onPlay={onPlay} onAction={onAction} {...props} /></ul>
    </OnDemandContext>,
  )
  return { onPlay, onAction, row: screen.getByRole('listitem') }
}

const menuItems = async (title: string) => {
  await userEvent.click(screen.getByRole('button', { name: `More options for ${title}` }))
  return (await screen.findAllByRole('menuitem')).map(item => item.textContent)
}

describe('TrackRow', () => {
  it('plays a track from its play button and on double click', async () => {
    const { onPlay, row } = renderRow('soft-signal')
    await userEvent.click(screen.getByRole('button', { name: 'Play Soft Signal' }))
    await userEvent.dblClick(row)
    expect(onPlay).toHaveBeenCalledTimes(2)
    expect(row).not.toHaveAttribute('aria-disabled')
  })

  it('lets a pointer reach the play button through the number it covers', () => {
    const { row } = renderRow('soft-signal')
    // jsdom does no hit testing: the faded number is a layer above the button, so it must let clicks through.
    expect(within(row).getByText('1')).toHaveClass('pointer-events-none')
  })

  it('looks the same for a requester whether the file is on the server or fetched as it plays', async () => {
    const { row: here, onPlay } = renderRow('soft-signal')
    const look = (row: HTMLElement, title: string) => ({
      title: row.getAttribute('title'),
      disabled: row.getAttribute('aria-disabled'),
      name: within(row).getByText(title).className,
      play: within(row).queryByRole('button', { name: `Play ${title}` }) !== null,
    })
    const onServer = look(here, 'Soft Signal')
    here.remove()
    const { row: fetched } = renderRow('night-swimming-demo')
    expect(look(fetched, 'Night Swimming (Demo)')).toEqual(onServer)
    expect(fetched.textContent).not.toMatch(/on demand|library|preparing|not available/i)
    expect(within(fetched).queryByLabelText(/on demand/i)).toBeNull()
    await userEvent.click(within(fetched).getByRole('button', { name: 'Play Night Swimming (Demo)' }))
    expect(onPlay).not.toHaveBeenCalled()
  })

  it.each([
    ['music no one can fetch', 'soft-signal-live', 'Soft Signal (Live)', requester],
    ['music the server fetches, to a member who may not fetch it', 'night-swimming-demo', 'Night Swimming (Demo)', member],
  ])('grays out %s and says only “Not available”', async (_case, slug, title, viewer) => {
    const { onPlay, row } = renderRow(slug, { viewer })
    expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(row).toHaveAttribute('title', 'Not available')
    expect(within(row).getByText('(Not available)')).toHaveClass('sr-only')
    expect(within(row).getByText(title)).toHaveClass('text-muted-foreground')
    expect(within(row).queryByRole('button', { name: `Play ${title}` })).toBeNull()
    // Not the whole row: its heart and More options still work.
    expect(within(row).getByRole('button', { name: `More options for ${title}` })).toBeEnabled()
    await userEvent.dblClick(row)
    expect(onPlay).not.toHaveBeenCalled()
  })

  it('shows the buffering spinner on the current track while its music is on its way, under the artist as always', () => {
    const id = track('night-swimming-demo').id
    const { row } = renderRow('night-swimming-demo', { nowPlaying: { trackId: id, playing: true, loading: true, onTogglePlay: () => {} } })
    expect(within(row).getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Mira Vale' })).toBeInTheDocument()
    expect(row.textContent).not.toMatch(/preparing/i)
  })

  it('shows nothing special on a song that is not current, while it waits to be fetched', () => {
    const { row } = renderRow('night-swimming-demo', { nowPlaying: { trackId: track('soft-signal').id, playing: true, loading: true, onTogglePlay: () => {} } })
    expect(within(row).queryByRole('status')).toBeNull()
  })

  it('marks the playing track and pauses it from its button', async () => {
    const onTogglePlay = vi.fn()
    const { row } = renderRow('night-swimming', { nowPlaying: { trackId: track('night-swimming').id, playing: true, loading: false, onTogglePlay } })
    expect(row).toHaveAttribute('aria-current', 'true')
    expect(within(row).getByRole('img', { name: 'Playing' })).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Pause Night Swimming' }))
    expect(onTogglePlay).toHaveBeenCalled()
  })

  describe('menu', () => {
    it('adds a song to the library', async () => {
      const { onAction } = renderRow('night-swimming-demo')
      expect(await menuItems('Night Swimming (Demo)')).toContain('Add to library')
      await userEvent.click(screen.getByRole('menuitem', { name: 'Add to library' }))
      expect(onAction).toHaveBeenCalledWith('library', track('night-swimming-demo'), 0)
    })

    it('removes a song the user added', async () => {
      const saved = { ...track('night-swimming-demo'), inLibrary: true, library: 'saved' as const }
      renderRow('night-swimming-demo', { track: saved })
      expect(await menuItems('Night Swimming (Demo)')).toContain('Remove from library')
    })

    it('offers no library entry for a song removing would not take out, or from a server that does not say', async () => {
      // A collection song, wherever it is listed: an artist's top songs, search, a playlist.
      for (const library of ['collection', 'album'] as const) {
        renderRow('soft-signal', { track: { ...track('soft-signal'), inLibrary: true, library } })
        const items = await menuItems('Soft Signal')
        expect(items).not.toContain('Remove from library')
        expect(items).not.toContain('Add to library')
        await userEvent.keyboard('{Escape}')
        screen.getByRole('listitem').remove()
      }
      renderRow('soft-signal', { track: { ...track('soft-signal'), inLibrary: undefined, library: undefined } })
      const items = await menuItems('Soft Signal')
      expect(items).not.toContain('Add to library')
      expect(items).not.toContain('Remove from library')
    })

    it('offers a page for each of the song\'s artists, each linking to its own', async () => {
      const lead = track('soft-signal').artists[0]!
      const guest = { id: '01a20236-8dd0-77ed-9c01-ab24582bf8cf', name: 'Guest Artist' }
      renderRow('soft-signal', { track: { ...track('soft-signal'), artistCredit: `${lead.name} feat. ${guest.name}`, artists: [lead, guest] } })
      expect(screen.getByRole('link', { name: lead.name })).toHaveAttribute('href', `/artist/${lead.id}`)
      expect(screen.getByRole('link', { name: guest.name })).toHaveAttribute('href', `/artist/${guest.id}`)
      const items = await menuItems('Soft Signal')
      expect(items).toContain(`Go to ${lead.name}`)
      expect(items).toContain(`Go to ${guest.name}`)
    })

    it('offers the Wantlist only for what does not play, and only with the Wantlist on', async () => {
      renderRow('night-swimming-demo', { wanted: false })
      expect(await menuItems('Night Swimming (Demo)')).not.toContain('Add to Wantlist')
      await userEvent.keyboard('{Escape}')
      screen.getByRole('listitem').remove()
      renderRow('soft-signal-live', { wanted: false })
      expect(await menuItems('Soft Signal (Live)')).toContain('Add to Wantlist')
      await userEvent.keyboard('{Escape}')
      screen.getByRole('listitem').remove()
      renderRow('soft-signal-live')
      expect(await menuItems('Soft Signal (Live)')).not.toContain('Add to Wantlist')
    })
  })

  it('shows the explicit badge and sends like actions', async () => {
    const { onAction } = renderRow('after-the-rain')
    expect(screen.getByTitle('Explicit')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save After the Rain to Liked Songs' }))
    expect(onAction).toHaveBeenCalledWith('like', track('after-the-rain'), 0)
  })
})
