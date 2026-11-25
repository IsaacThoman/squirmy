import type { Lyrics } from '@squirmy/contracts'
import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { blurReach, lineLook, resumeFollowMs } from '@/lib/lyrics'
import { renderWithApp } from '@/test/render'
import { LyricsPane } from './Lyrics'

const synced: Lyrics = { trackId: '00000000-0000-4000-8300-000000000002', synced: '[00:01.00]One\n[00:02.00]Two\n[00:03.00]Three', plain: null, instrumental: false, source: 'LRCLIB' }
const plain: Lyrics = { trackId: '00000000-0000-4000-8300-000000000001', synced: null, plain: 'Paper boats\nOn the water', instrumental: false, source: 'LRCLIB' }

describe('LyricsPane', () => {
  it('says the lyrics are loading, not that there are none, while they are on their way', () => {
    renderWithApp(<LyricsPane lyrics={null} status="loading" onSeek={vi.fn()} />)
    expect(screen.getByRole('status', { name: 'Loading lyrics' })).toBeInTheDocument()
    expect(screen.queryByText('No lyrics for this song')).toBeNull()
  })

  it('offers a retry when they did not load', async () => {
    const onRetry = vi.fn()
    renderWithApp(<LyricsPane lyrics={null} status="failed" onRetry={onRetry} onSeek={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('The lyrics did not load')
    expect(screen.queryByText('No lyrics for this song')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('says there are none only once the server said so', () => {
    renderWithApp(<LyricsPane lyrics={null} status="none" onSeek={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'No lyrics for this song' })).toBeInTheDocument()
  })

  it('shows them once they came', () => {
    renderWithApp(<LyricsPane lyrics={plain} status="ready" onSeek={vi.fn()} />)
    expect(screen.getByText(/Paper boats/)).toBeInTheDocument()
    expect(screen.getByText('Lyrics from LRCLIB')).toBeInTheDocument()
  })

  it('is one stop for Tab, moved through with the arrow keys, and seeks with Enter', async () => {
    const onSeek = vi.fn()
    renderWithApp(<><button type="button">Before</button><LyricsPane lyrics={synced} status="ready" onSeek={onSeek} /><button type="button">After</button></>)
    const list = screen.getByRole('listbox', { name: 'Lyrics' })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    screen.getByRole('button', { name: 'Before' }).focus()
    await userEvent.tab()
    // Tab comes to the line playing, or the first.
    const playing = screen.getAllByRole('option').find(option => option.getAttribute('aria-selected') === 'true') ?? screen.getByRole('option', { name: 'One' })
    expect(document.activeElement).toBe(playing)
    await userEvent.keyboard('{Home}{ArrowDown}{ArrowDown}')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Three' }))
    await userEvent.keyboard('{Enter}')
    expect(onSeek).toHaveBeenLastCalledWith(3000)
    await userEvent.keyboard('{ArrowUp}')
    expect(document.activeElement).toBe(screen.getByRole('option', { name: 'Two' }))
    // One more Tab leaves the lyrics, whatever line the keyboard was on.
    await userEvent.tab()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'After' }))
    expect(list).toBeInTheDocument()
  })

  it('dims and blurs the lines more the farther they are from the sung one, and sharpens them all while a reader scrolls', () => {
    vi.useFakeTimers()
    try {
      renderWithApp(<LyricsPane lyrics={synced} status="ready" onSeek={vi.fn()} />)
      const options = screen.getAllByRole('option')
      const sung = options.findIndex(option => option.getAttribute('aria-selected') === 'true')
      // Every line takes its look from how far it is from the sung one (before the first, from just above it).
      for (const [index, option] of options.entries()) {
        const look = lineLook(index - sung, false)
        expect(option.style.getPropertyValue('--lyric-blur')).toBe(`${look.blur}px`)
        expect(option.style.getPropertyValue('--lyric-opacity')).toBe(String(look.opacity))
      }
      const two = screen.getByRole('option', { name: 'Two' })
      const resting = two.style.getPropertyValue('--lyric-blur')
      fireEvent.wheel(screen.getByRole('listbox', { name: 'Lyrics' }), { deltaY: 40 })
      expect(two.style.getPropertyValue('--lyric-blur')).toBe('0px')
      expect(two.style.getPropertyValue('--lyric-opacity')).toBe('0.62')
      expect(two.className).not.toContain('filter:blur')
      expect(options.every(option => option.style.getPropertyValue('--lyric-blur') === '0px')).toBe(true)
      act(() => vi.advanceTimersByTime(resumeFollowMs))
      expect(two.style.getPropertyValue('--lyric-blur')).toBe(resting)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('lineLook', () => {
  it('keeps the sung line bright and sharp, and blurs the rest by distance up to a limit', () => {
    expect(lineLook(0, false)).toEqual({ opacity: 1, blur: 0 })
    expect(lineLook(-1, false).blur).toBeCloseTo(1.1)
    expect(lineLook(3, false).blur).toBeCloseTo(3.3)
    expect(lineLook(6, false).blur).toBe(5.5)
    expect(lineLook(blurReach + 1, false)).toEqual({ opacity: 0.3, blur: 0 })
    expect(lineLook(4, true)).toEqual({ opacity: 0.62, blur: 0 })
  })
})

