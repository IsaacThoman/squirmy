import type { Artwork } from '@squirmy/contracts'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Cover } from './Cover'

const first: Artwork = { id: '00000000-0000-4000-8900-000000000101', color: '#344763', thumbhash: null }
const second: Artwork = { id: '00000000-0000-4000-8900-000000000102', color: '#5a342a', thumbhash: null }
const url = (artwork: Artwork, size: number) => `/art/${artwork.id}/${size}`
const images = (container: HTMLElement) => [...container.querySelectorAll('img')].map(image => image.getAttribute('src'))

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Cover with crossfade', () => {
  it('keeps the cover before until the new one has loaded and faded up over it', () => {
    const { container, rerender } = render(<Cover artwork={first} artUrl={url} size={96} crossfade />)
    fireEvent.load(container.querySelector('img')!)
    rerender(<Cover artwork={second} artUrl={url} size={96} crossfade />)
    // The new cover loads over the old one, which stays on screen meanwhile.
    expect(images(container)).toEqual([url(first, 96), url(second, 96)])
    act(() => vi.advanceTimersByTime(2000))
    expect(images(container)).toEqual([url(first, 96), url(second, 96)])
    fireEvent.load(container.querySelectorAll('img')[1]!)
    act(() => vi.advanceTimersByTime(359))
    expect(images(container)).toHaveLength(2)
    act(() => vi.advanceTimersByTime(1))
    expect(images(container)).toEqual([url(second, 96)])
  })

  it('swaps at once without it, over the new cover\'s placeholder', () => {
    const { container, rerender } = render(<Cover artwork={first} artUrl={url} size={96} />)
    fireEvent.load(container.querySelector('img')!)
    rerender(<Cover artwork={second} artUrl={url} size={96} />)
    expect(images(container)).toEqual([url(second, 96)])
  })
})
