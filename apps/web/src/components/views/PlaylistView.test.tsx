import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { playlistSummaries } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'

const empty = playlistSummaries.find(playlist => playlist.name === 'Empty for now')!

/** A screen whose main pointer is a finger, or a mouse. */
function pointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media, matches: coarse && media === '(pointer: coarse)', addEventListener() {}, removeEventListener() {},
  }))
}

afterEach(() => vi.unstubAllGlobals())

describe('an empty playlist of your own', () => {
  it('says songs can be dragged onto it in the sidebar, with a mouse', async () => {
    pointer(false)
    renderWithApp(<AppRoutes />, `/playlist/${empty.id}`)
    expect(await screen.findByRole('heading', { name: 'This playlist is empty' })).toBeInTheDocument()
    expect(screen.getByText(/drag them onto the playlist in the sidebar/)).toBeInTheDocument()
  })

  it('points a finger at the song menu, which a touch screen has, rather than a drag it lacks', async () => {
    pointer(true)
    renderWithApp(<AppRoutes />, `/playlist/${empty.id}`)
    expect(await screen.findByRole('heading', { name: 'This playlist is empty' })).toBeInTheDocument()
    expect(screen.getByText(/open a song’s menu and choose Add to playlist/)).toBeInTheDocument()
    expect(screen.queryByText(/drag/i)).toBeNull()
  })
})
