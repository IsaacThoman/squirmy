import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import type { QueueItem } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import type { Player, PlayerControls, PlayerState } from '@/player/player-context'
import { QueueContent, SortableQueue } from './Queue'

const items: QueueItem[] = ['soft-signal', 'amber', 'passing-glass'].map((slug, index) => {
  const item = track(slug)
  return { track: item, entry: { id: `e${index}`, trackId: item.id, albumId: null, durationMs: item.durationMs, state: 'ready' } }
})

function renderQueue() {
  const handlers = { onMove: vi.fn(), onRemove: vi.fn(), onPlay: vi.fn() }
  renderWithApp(<SortableQueue items={items} {...handlers} />)
  return handlers
}

describe('SortableQueue', () => {
  it('moves an entry with the arrow keys on its song button', () => {
    const { onMove } = renderQueue()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Play Amber' }), { key: 'ArrowDown' })
    expect(onMove).toHaveBeenCalledWith('e1', 2)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Play Amber' }), { key: 'ArrowUp' })
    expect(onMove).toHaveBeenLastCalledWith('e1', 0)
    expect(screen.getByText('Amber moved to position 1 of 3')).toBeInTheDocument()
  })

  it('does not move past either end', () => {
    const { onMove } = renderQueue()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Play Soft Signal' }), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Play Passing Glass' }), { key: 'ArrowDown' })
    expect(onMove).not.toHaveBeenCalled()
  })

  it('drags the song row and suppresses the click that would play it', () => {
    const { onMove, onPlay } = renderQueue()
    const row = screen.getByRole('button', { name: 'Play Soft Signal' })
    fireEvent.pointerDown(row, { button: 0, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(row, { clientY: 100 + 48 * 2, pointerId: 1 })
    fireEvent.pointerUp(row, { pointerId: 1 })
    fireEvent.click(row, { detail: 1 })
    expect(onMove).toHaveBeenCalledWith('e0', 2)
    expect(onPlay).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Reorder/ })).toBeNull()
  })

  it('still plays when a pointer clicks without dragging', () => {
    const { onMove, onPlay } = renderQueue()
    const row = screen.getByRole('button', { name: 'Play Amber' })
    fireEvent.pointerDown(row, { button: 0, clientY: 100, pointerId: 1 })
    fireEvent.pointerMove(row, { clientY: 102, pointerId: 1 })
    fireEvent.pointerUp(row, { pointerId: 1 })
    fireEvent.click(row, { detail: 1 })
    expect(onMove).not.toHaveBeenCalled()
    expect(onPlay).toHaveBeenCalledWith('e1')
  })

  it('starts a touch drag after holding, but lets an ordinary swipe scroll', () => {
    vi.useFakeTimers()
    try {
      const { onMove } = renderQueue()
      const row = screen.getByRole('button', { name: 'Play Soft Signal' })
      const down = () => fireEvent.pointerDown(row, { button: 0, clientY: 100, pointerId: 1, pointerType: 'touch' })
      const swipe = () => fireEvent.pointerMove(row, { clientY: 148, pointerId: 1, pointerType: 'touch' })
      const up = () => fireEvent.pointerUp(row, { pointerId: 1, pointerType: 'touch' })
      down()
      swipe()
      act(() => vi.advanceTimersByTime(360))
      up()
      expect(onMove).not.toHaveBeenCalled()
      down()
      act(() => vi.advanceTimersByTime(360))
      swipe()
      up()
      expect(onMove).toHaveBeenCalledWith('e0', 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('has the heart on every song, saved or not', () => {
    const mixed = items.map((item, index) => ({ ...item, track: { ...item.track, liked: index === 0 } }))
    renderWithApp(<SortableQueue items={mixed} onMove={vi.fn()} onRemove={vi.fn()} onPlay={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Remove Soft Signal from library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Amber to library' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save Passing Glass to library' })).toBeInTheDocument()
  })

  it('removes and plays entries', async () => {
    const { onRemove, onPlay } = renderQueue()
    await userEvent.click(screen.getByRole('button', { name: 'Remove Amber from queue' }))
    await userEvent.click(screen.getByRole('button', { name: 'Play Passing Glass' }))
    expect(onRemove).toHaveBeenCalledWith('e1')
    expect(onPlay).toHaveBeenCalledWith('e2')
  })

  it('shows upcoming songs that wait to be fetched like any other', () => {
    const waiting = items.map(item => ({ ...item, track: { ...item.track, availability: 'on_demand' as const }, entry: { ...item.entry, state: 'preparing' as const } }))
    renderWithApp(<SortableQueue items={waiting} onMove={vi.fn()} onRemove={vi.fn()} onPlay={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/preparing|on demand/i)).toBeNull()
    expect(screen.getByRole('button', { name: 'Play Amber' })).toHaveTextContent('Amber')
  })

  it('grays out a song that could not be had and says “Not available”', () => {
    const failed = items.map((item, index) => (index === 1 ? { ...item, entry: { ...item.entry, state: 'failed' as const } } : item))
    renderWithApp(<SortableQueue items={failed} onMove={vi.fn()} onRemove={vi.fn()} onPlay={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Play Amber' })).toBeNull()
    expect(screen.getByText('Not available')).toBeInTheDocument()
    expect(screen.getByText('Amber')).toHaveClass('text-muted-foreground')
  })
})

describe('QueueContent', () => {
  it('fades the artwork of history rows, never their words', () => {
    const state = { current: null, playing: false, waiting: false, queue: [], history: items, autoplayQueue: [], autoplay: false, shuffle: false, repeat: 'off' } as unknown as PlayerState
    const player = { state, controls: new Proxy({}, { get: () => vi.fn() }) as PlayerControls } satisfies Player
    renderWithApp(<QueueContent player={player} />)
    const title = screen.getByText('Amber')
    for (let node: HTMLElement | null = title; node; node = node.parentElement) expect(node.className).not.toMatch(/(^|\s)opacity-/)
  })

  const queueState = (overrides: Partial<PlayerState>) => ({
    current: null, playing: false, waiting: false, queue: [], history: [], autoplayQueue: [], autoplay: false, shuffle: false, repeat: 'off', context: null, outage: null, ...overrides,
  }) as unknown as PlayerState
  const render = (state: PlayerState, props: { modes?: boolean } = {}) => {
    const controls = new Proxy({}, { get: () => vi.fn() }) as PlayerControls
    renderWithApp(<QueueContent player={{ state, controls }} {...props} />)
  }

  it('lists the history first, oldest at the top, then the song playing, then up next and autoplay, as the iOS app does', () => {
    const [first, second, third] = items
    render(queueState({ history: [first, second], current: third, queue: [{ ...first, entry: { ...first.entry, id: 'q0' } }] }))
    const headings = screen.getAllByRole('heading').map(heading => heading.textContent)
    expect(headings).toEqual(['History', 'Up Next', 'Autoplay'])
    const titles = screen.getAllByText(/^(Soft Signal|Amber|Passing Glass)$/).map(node => node.textContent)
    expect(titles).toEqual(['Soft Signal', 'Amber', 'Passing Glass', 'Soft Signal'])
    const history = screen.getByRole('heading', { name: 'History' })
    const playing = screen.getByRole('region', { name: 'Now playing' })
    expect(history.compareDocumentPosition(playing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says “Continue Playing” and where the songs are from while all of them come from what is playing', () => {
    render(queueState({ context: { type: 'album', id: 'a1', title: 'Night Drives' }, queue: items }))
    expect(screen.getByRole('heading', { name: 'Continue Playing' })).toBeInTheDocument()
    expect(screen.getByText('From Night Drives')).toBeInTheDocument()
  })

  it('says “Up Next” and how many songs once some were queued by hand', () => {
    const queued = items.map((item, index) => ({ ...item, entry: { ...item.entry, queued: index === 0 } }))
    render(queueState({ context: { type: 'album', id: 'a1', title: 'Night Drives' }, queue: queued }))
    expect(screen.getByRole('heading', { name: 'Up Next' })).toBeInTheDocument()
    expect(screen.getByText('3 songs')).toBeInTheDocument()
  })

  it('has Autoplay among the toggles', () => {
    render(queueState({}))
    expect(screen.getByRole('button', { name: 'Autoplay', pressed: false })).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Autoplay' })).toBeNull()
  })

  it('keeps the switch beside the Autoplay heading without the toggles', () => {
    render(queueState({ autoplay: true }), { modes: false })
    expect(screen.getByRole('switch', { name: 'Autoplay' })).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Shuffle' })).toBeNull()
  })
})
