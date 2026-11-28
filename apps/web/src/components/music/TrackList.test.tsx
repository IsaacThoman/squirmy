import type { TrackSummary } from '@squirmy/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import type { Viewer } from '@/lib/catalog'
import { OnDemandContext } from '@/player/on-demand-context'
import { NowPlayingContext, NowPlayingStore, PlayerControlsContext, usePlayerControls, type NowPlaying } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import { TrackRow } from './TrackList'

const requester: Viewer = { role: 'member', canAcquire: true }
const member: Viewer = { role: 'member', canAcquire: false }

type RowOptions = { nowPlaying?: NowPlaying; onTogglePlay?: () => void; viewer?: Viewer; wanted?: boolean; track?: TrackSummary }

/** The fixture player's commands, with play and pause going to `onTogglePlay`. */
function TogglePlay({ onTogglePlay, children }: { onTogglePlay?: () => void; children: ReactNode }) {
  const controls = usePlayerControls()
  return <PlayerControlsContext value={onTogglePlay ? { ...controls, togglePlay: onTogglePlay } : controls}>{children}</PlayerControlsContext>
}

function renderRow(slug: string, { viewer = requester, nowPlaying, onTogglePlay, ...props }: RowOptions = {}) {
  const onPlay = vi.fn()
  const onAction = vi.fn()
  renderWithApp(
    <OnDemandContext value={{ viewer }}>
      <NowPlayingContext value={new NowPlayingStore(nowPlaying ?? null)}>
        <TogglePlay onTogglePlay={onTogglePlay}>
          <ul><TrackRow track={track(slug)} index={0} variant="album" onPlay={onPlay} onAction={onAction} {...props} /></ul>
        </TogglePlay>
      </NowPlayingContext>
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
  it('opens the row menu from the keyboard and right click and restores focus', async () => {
    const { row } = renderRow('soft-signal')
    const trigger = screen.getByRole('button', { name: 'More options for Soft Signal' })
    expect(screen.queryByRole('menu')).toBeNull()
    trigger.focus()
    expect(screen.queryByRole('menu')).toBeNull()
    await userEvent.keyboard('{ArrowDown}')
    expect((await screen.findAllByRole('menuitem'))[0]).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
    fireEvent.contextMenu(row, { clientX: 100, clientY: 120 })
    expect(await screen.findByRole('menuitem', { name: 'Start radio' })).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

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
    const { row } = renderRow('night-swimming-demo', { nowPlaying: { trackId: id, playing: true, loading: true } })
    expect(within(row).getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(within(row).getByRole('link', { name: 'Mira Vale' })).toBeInTheDocument()
    expect(row.textContent).not.toMatch(/preparing/i)
  })

  it('shows nothing special on a song that is not current, while it waits to be fetched', () => {
    const { row } = renderRow('night-swimming-demo', { nowPlaying: { trackId: track('soft-signal').id, playing: true, loading: true } })
    expect(within(row).queryByRole('status')).toBeNull()
  })

  it('marks the playing track and pauses it from its button', async () => {
    const onTogglePlay = vi.fn()
    const { row } = renderRow('night-swimming', { nowPlaying: { trackId: track('night-swimming').id, playing: true, loading: false }, onTogglePlay })
    expect(row).toHaveAttribute('aria-current', 'true')
    // A fill and the playing glyph mark it; the title keeps the text color, which reads on the fill in every theme.
    expect(row).toHaveClass('bg-accent/40')
    expect(within(row).getByText('Night Swimming')).not.toHaveClass('text-primary')
    expect(within(row).getByRole('img', { name: 'Playing' })).toBeInTheDocument()
    await userEvent.click(within(row).getByRole('button', { name: 'Pause Night Swimming' }))
    expect(onTogglePlay).toHaveBeenCalled()
  })

  it('shows the current song its fetch failed for as unavailable, not as current', () => {
    const id = track('night-swimming-demo').id
    const { row } = renderRow('night-swimming-demo', { nowPlaying: { trackId: id, playing: false, loading: false, failed: true } })
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

  /** Soft Signal with a featured artist, so its credit has two links. */
  const featuring = (): TrackSummary => {
    const base = track('soft-signal')
    return { ...base, artistCredit: `${base.artists[0].name} feat. Lune Park`, artists: [...base.artists, { ...base.artists[0], id: 'artist-lune-park', name: 'Lune Park' }] }
  }
  const renderSong = (song: TrackSummary, variant: 'compact' | 'album' = 'compact') => renderWithApp(
    <OnDemandContext value={{ viewer: requester }}>
      <ul><TrackRow track={song} index={0} variant={variant} onPlay={vi.fn()} onAction={vi.fn()} /></ul>
    </OnDemandContext>,
  )

  it('keeps its artist and album links in the Tab order while they are drawn whole', () => {
    renderSong(featuring())
    const links = within(screen.getByRole('listitem')).getAllByRole('link')
    expect(links.map(link => link.textContent)).toEqual(['Mira Vale', 'Lune Park', 'Blue Hour'])
    for (const link of links) expect(link).not.toHaveAttribute('tabindex')
  })

  it('takes a link its ellipsis cuts out of the Tab order, and only that one', () => {
    // Lines 100 px wide: Mira Vale ends inside its line, Lune Park and the album's title run past the edge.
    const ends: Record<string, number> = { 'Mira Vale': 60, 'Lune Park': 140, 'Blue Hour': 150 }
    // The lines are measured when their observer first reports, as a browser's does once laid out.
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) { this.callback = callback }
      observe(target: Element) { this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver) }
      unobserve() {}
      disconnect() {}
    })
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const right = this.tagName === 'A' ? ends[this.textContent ?? ''] ?? 0 : this.querySelector('a') ? 100 : 0
      return { right, left: 0, top: 0, bottom: 0, width: right, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    try {
      const song = featuring()
      renderSong(song)
      const row = screen.getByRole('listitem')
      expect(within(row).getByRole('link', { name: 'Mira Vale' })).not.toHaveAttribute('tabindex')
      expect(within(row).getByRole('link', { name: 'Lune Park' })).toHaveAttribute('tabindex', '-1')
      expect(within(row).getByRole('link', { name: 'Blue Hour' })).toHaveAttribute('tabindex', '-1')
      // The tooltip has the whole credit.
      expect(within(row).getByRole('link', { name: 'Mira Vale' }).parentElement).toHaveAttribute('title', song.artistCredit)
    } finally {
      rect.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('offers the album and every credited artist in its menu, which opens with the whole title and credit', async () => {
    const song = featuring()
    renderSong(song)
    const items = await menuItems('Soft Signal')
    expect(items).toEqual(expect.arrayContaining(['Go to album', 'Go to Mira Vale', 'Go to Lune Park']))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByText('Soft Signal')).toBeInTheDocument()
    expect(within(menu).getByText(song.artistCredit)).toBeInTheDocument()
  })

  it('on an album page offers each artist of a featured credit, but not the album it is on', async () => {
    renderSong(featuring(), 'album')
    const items = await menuItems('Soft Signal')
    expect(items).not.toContain('Go to album')
    expect(items).toEqual(expect.arrayContaining(['Go to Mira Vale', 'Go to Lune Park']))
  })

  it('grays an explicit song for a viewer who has explicit content off, and says why', () => {
    const { row } = renderRow('after-the-rain', { viewer: { ...requester, allowsExplicit: false } })
    expect(screen.queryByRole('button', { name: 'Play After the Rain' })).toBeNull()
    expect(row).toHaveTextContent('(Explicit content is off)')
    expect(screen.getByTitle('Explicit')).toBeInTheDocument()
  })

  it('plays a clean song for that viewer', () => {
    renderRow('soft-signal', { viewer: { ...requester, allowsExplicit: false } })
    expect(screen.getByRole('button', { name: 'Play Soft Signal' })).toBeInTheDocument()
  })

  it('shows the explicit badge and saves from the heart', async () => {
    const { onAction } = renderRow('after-the-rain')
    expect(screen.getByTitle('Explicit')).toHaveTextContent('Explicit')
    await userEvent.click(screen.getByRole('button', { name: 'Save After the Rain to library' }))
    expect(onAction).toHaveBeenCalledWith('like', track('after-the-rain'), 0)
  })
})
