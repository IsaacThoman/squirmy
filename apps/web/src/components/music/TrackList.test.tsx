import type { TrackSummary } from '@squirmy/contracts'
import { fireEvent, screen, within } from '@testing-library/react'
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

/** A press from a mouse or a finger. jsdom's events carry no `pointerType`, so it is set by hand. */
function press(element: Element, pointerType: 'mouse' | 'touch') {
  const down = new MouseEvent('pointerdown', { bubbles: true })
  Object.defineProperty(down, 'pointerType', { value: pointerType })
  fireEvent(element, down)
  fireEvent.click(element)
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

  it('shows the credit as it reads, each artist in it a link', () => {
    const base = track('soft-signal')
    const guest = { id: '00000000-0000-4000-8100-0000000000aa', name: 'Lune Park' }
    const { row } = renderRow('soft-signal', { track: { ...base, artistCredit: `${base.artistCredit} feat. ${guest.name}`, artists: [...base.artists, guest] } })
    expect(row.textContent).toContain(`${base.artistCredit} feat. ${guest.name}`)
    expect(within(row).getByRole('link', { name: guest.name })).toHaveAttribute('href', `/artist/${guest.id}`)
    expect(within(row).getByRole('link', { name: base.artistCredit })).toBeInTheDocument()
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
    // Only playing is unavailable: marking the row disabled would tell a screen reader its working heart and menu are too.
    expect(row).not.toHaveAttribute('aria-disabled')
    expect(row).toHaveAttribute('title', 'Not available')
    expect(within(row).getByText('(Not available)')).toHaveClass('sr-only')
    expect(within(row).getByText(title)).toHaveClass('text-faded-foreground')
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
    // A fill as well as the title's color, which is close to the text's in some themes.
    expect(row).toHaveClass('bg-accent/40')
    expect(within(row).getByText('Night Swimming')).toHaveClass('text-primary')
    expect(within(row).getByRole('img', { name: 'Playing' })).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Pause Night Swimming' }))
    expect(onTogglePlay).toHaveBeenCalled()
  })

  it('shows the current song its fetch failed for as unavailable, not as current', () => {
    const id = track('night-swimming-demo').id
    const { row } = renderRow('night-swimming-demo', { nowPlaying: { trackId: id, playing: false, loading: false, failed: true, onTogglePlay: () => {} } })
    // Unavailable as #129 marks it: faded, the title and a hidden label say so, no play button;
    // its heart and menu still work, so the row is not disabled.
    expect(row).toHaveAttribute('title', 'Not available')
    expect(within(row).getByText('(Not available)')).toHaveClass('sr-only')
    expect(within(row).queryByRole('button', { name: `Play ${track('night-swimming-demo').title}` })).toBeNull()
    expect(row).not.toHaveAttribute('aria-current')
    expect(within(row).queryByRole('img', { name: 'Playing' })).toBeNull()
    expect(within(row).getByText(track('night-swimming-demo').title)).not.toHaveClass('text-primary')
  })

  describe('menu', () => {
    it('has one library entry, worded like the heart, that saves the song', async () => {
      const { onAction } = renderRow('night-swimming-demo')
      const items = await menuItems('Night Swimming (Demo)')
      expect(items.filter(item => /library|Liked Songs/.test(item ?? ''))).toEqual(['Save to library'])
      await userEvent.click(screen.getByRole('menuitem', { name: 'Save to library' }))
      expect(onAction).toHaveBeenCalledWith('like', track('night-swimming-demo'), 0)
    })

    it('offers Remove from library for a saved song, wherever its file is', async () => {
      // The heart shows the viewer's own save, so a song of the collection has the entry too.
      renderRow('soft-signal', { track: { ...track('soft-signal'), liked: true, inLibrary: true, library: 'collection' } })
      const items = await menuItems('Soft Signal')
      expect(items).toContain('Remove from library')
      expect(items).not.toContain('Save to library')
    })

    it('offers Save to library on a collection song the viewer has not saved', async () => {
      renderRow('soft-signal', { track: { ...track('soft-signal'), liked: false, inLibrary: true, library: 'collection' } })
      expect(screen.getByRole('button', { name: 'Save Soft Signal to library' })).toBeInTheDocument()
      expect(await menuItems('Soft Signal')).toContain('Save to library')
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

  it('plays from a tap anywhere on the row on a touch screen, but not from a mouse click or a tap on a link', async () => {
    const { onPlay, row } = renderRow('soft-signal')
    const title = within(row).getByText('Soft Signal')
    press(title, 'mouse')
    expect(onPlay).not.toHaveBeenCalled()
    press(title, 'touch')
    expect(onPlay).toHaveBeenCalledTimes(1)
    press(within(row).getByRole('link', { name: 'Mira Vale' }), 'touch')
    expect(onPlay).toHaveBeenCalledTimes(1)
  })

  it('does not play an unavailable song from a tap', () => {
    const { onPlay, row } = renderRow('soft-signal-live')
    press(row, 'touch')
    expect(onPlay).not.toHaveBeenCalled()
  })

  it('keeps its artist and album links, which are cut short in narrow rows, out of the Tab order and offers them in its menu', async () => {
    renderWithApp(
      <OnDemandContext value={{ viewer: requester }}>
        <ul><TrackRow track={track('soft-signal')} index={0} variant="compact" onPlay={vi.fn()} onAction={vi.fn()} /></ul>
      </OnDemandContext>,
    )
    const row = screen.getByRole('listitem')
    for (const link of within(row).getAllByRole('link')) expect(link).toHaveAttribute('tabindex', '-1')
    expect(within(row).getByRole('link', { name: 'Mira Vale' }).parentElement).toHaveAttribute('title', track('soft-signal').artistCredit)
    const items = await menuItems('Soft Signal')
    expect(items).toContain('Go to album')
    expect(items).toContain('Go to artist')
  })

  it('shows the explicit badge and saves from the heart', async () => {
    const { onAction } = renderRow('after-the-rain')
    expect(screen.getByTitle('Explicit')).toHaveTextContent('Explicit')
    await userEvent.click(screen.getByRole('button', { name: 'Save After the Rain to library' }))
    expect(onAction).toHaveBeenCalledWith('like', track('after-the-rain'), 0)
  })
})
