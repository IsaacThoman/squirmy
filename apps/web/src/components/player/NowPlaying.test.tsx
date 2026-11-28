import { act, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'
import { nextArtwork } from './use-next-artwork'
import { NowPlaying } from './NowPlaying'
import { LEAN_BACK_IDLE_MS } from './use-idle'

const nowPlaying = () => renderWithApp(<NowPlaying open onOpenChange={() => {}} pane="art" onPaneChange={() => {}} />)
const ambient = () => document.querySelector<HTMLElement>('.ambient')!

class ImageDataStub {
  readonly data: Uint8ClampedArray
  readonly width: number
  readonly height: number
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data
    this.width = width
    this.height = height
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  // jsdom draws no canvas: the backdrop's pixels are kept, and drawing them is a no-op.
  vi.stubGlobal('ImageData', ImageDataStub)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: () => {} } as unknown as CanvasRenderingContext2D)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Now Playing\'s ambient backdrop', () => {
  it('turns the cover\'s colors in two layers, and stops turning while the music is paused', () => {
    nowPlaying()
    const artwork = track('night-swimming').album!.artwork!
    const layers = ambient().querySelectorAll<HTMLElement>('.ambient-layer')
    expect(layers).toHaveLength(1)
    expect(layers[0]!.style.backgroundColor).not.toBe('')
    // Drawn from the ThumbHash: a canvas of a few dozen pixels each, scaled up by the compositor.
    const canvases = ambient().querySelectorAll('canvas')
    expect(canvases).toHaveLength(2)
    expect(canvases[0]!.width).toBeLessThanOrEqual(32)
    expect(artwork.thumbhash).toBeTruthy()
    expect(ambient()).toHaveAttribute('data-turning', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(ambient()).toHaveAttribute('data-turning', 'false')
  })

  it('fades the next song\'s colors in over the last song\'s', () => {
    nowPlaying()
    // On to the first song in the queue from another album.
    for (let skip = 0; skip < 6 && ambient().querySelectorAll('.ambient-layer').length < 2; skip++) fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    const layers = ambient().querySelectorAll('.ambient-layer')
    expect(layers).toHaveLength(2)
    expect(layers[1]).toHaveClass('ambient-fade')
    act(() => vi.advanceTimersByTime(900))
    expect(ambient().querySelectorAll('.ambient-layer')).toHaveLength(1)
  })

  it('preloads the cover of the song after this one', () => {
    const current = { track: track('night-swimming') }
    const next = { track: track('strange-seasons') }
    expect(nextArtwork({ current, queue: [next], autoplayQueue: [] } as never)).toBe(next.track.album!.artwork)
    // With the queue done, Autoplay's next song.
    expect(nextArtwork({ current, queue: [], autoplayQueue: [next] } as never)).toBe(next.track.album!.artwork)
    // The same cover (the next song is on the same album) needs nothing.
    expect(nextArtwork({ current, queue: [current], autoplayQueue: [] } as never)).toBeNull()
  })
})

describe('lean-back mode', () => {
  it('fills the screen from the Full screen button and leaves with Escape, keeping Now Playing open', () => {
    const requestFullscreen = vi.fn(() => Promise.resolve())
    document.documentElement.requestFullscreen = requestFullscreen
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true })
    nowPlaying()
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    expect(requestFullscreen).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-lean-back]')).not.toBeNull()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(document.querySelector('[data-lean-back]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Close Now Playing' })).toBeInTheDocument()
  })

  it('goes in and out with F', () => {
    nowPlaying()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Now Playing' }), { key: 'f' })
    expect(document.querySelector('[data-lean-back]')).not.toBeNull()
    // It starts on the screen itself, where Enter plays and pauses as Space does.
    const screenItself = screen.getByLabelText('Full screen player')
    expect(document.activeElement).toBe(screenItself)
    fireEvent.keyDown(screenItself, { key: 'Enter' })
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    fireEvent.keyDown(screenItself, { key: 'f' })
    expect(document.querySelector('[data-lean-back]')).toBeNull()
  })

  it('leaves for Now Playing\'s queue or lyrics with Q and Y, which it does not show', () => {
    const onPaneChange = vi.fn()
    renderWithApp(<NowPlaying open onOpenChange={() => {}} pane="art" onPaneChange={onPaneChange} />)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Now Playing' }), { key: 'f' })
    fireEvent.keyDown(screen.getByLabelText('Full screen player'), { key: 'q' })
    expect(document.querySelector('[data-lean-back]')).toBeNull()
    expect(onPaneChange).toHaveBeenLastCalledWith('queue')
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Now Playing' }), { key: 'f' })
    fireEvent.keyDown(screen.getByLabelText('Full screen player'), { key: 'y' })
    expect(onPaneChange).toHaveBeenLastCalledWith('lyrics')
  })

  it('opens the song\'s menu from a right-click on the cover, whose letters stay in the menu', async () => {
    nowPlaying()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Now Playing' }), { key: 'f' })
    fireEvent.contextMenu(document.querySelector('[data-lean-back] img')!)
    const item = await screen.findAllByRole('menuitem')
    // F picks an item here: it neither leaves full screen nor reaches the shell.
    fireEvent.keyDown(item[0]!, { key: 'f' })
    expect(document.querySelector('[data-lean-back]')).not.toBeNull()
  })

  it('hides the controls while the music plays untouched, and a key that only wakes them does nothing else', () => {
    nowPlaying()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close Now Playing' }), { key: 'f' })
    const leanBack = document.querySelector('[data-lean-back]')!
    expect(leanBack).not.toHaveAttribute('data-idle')
    act(() => vi.advanceTimersByTime(LEAN_BACK_IDLE_MS))
    expect(leanBack).toHaveAttribute('data-idle')
    const pause = screen.getByRole('button', { name: 'Pause' })
    pause.focus()
    act(() => vi.advanceTimersByTime(LEAN_BACK_IDLE_MS))
    expect(leanBack).toHaveAttribute('data-idle')
    // Enter on a hidden button only brings the controls back: the music keeps playing.
    fireEvent.keyDown(pause, { key: 'Enter' })
    expect(leanBack).not.toHaveAttribute('data-idle')
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()
    // ← and → move along the transport, as a TV remote does.
    fireEvent.keyDown(pause, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }))
    // Paused, they stay.
    fireEvent.click(pause)
    act(() => vi.advanceTimersByTime(LEAN_BACK_IDLE_MS * 2))
    expect(leanBack).not.toHaveAttribute('data-idle')
  })
})
