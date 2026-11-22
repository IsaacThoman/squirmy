import type { Lyrics } from '@squirmy/contracts'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { renderWithApp } from '@/test/render'
import { LyricsPane } from './Lyrics'

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
})
