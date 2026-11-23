import type { AlbumDetail } from '@squirmy/contracts'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album, artistDetail, summary } from '@/fixtures/catalog'
import { users } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { dismissToast, toastStore } from '@/lib/toast'
import { TRACK_LIST_WAIT_MS } from './AlbumView'
import { AlbumPreview } from './Previews'

const lowTide = album('low-tide')
const blueHour = album('blue-hour')
const slowMotion = album('slow-motion')
/** A member who may not have the server fetch music. */
const robin = users[2]!
const machinery = /on demand|library yet|get this album|preparing|not on the server|in your library|fetch/i
const toasts = () => [...document.querySelectorAll('[data-toast]')].map(item => item.textContent)

afterEach(() => {
  for (const item of toastStore.getSnapshot()) dismissToast(item.id)
})

describe('album page', () => {
  describe('for someone the server fetches music for', () => {
    it('looks like any album, with nothing about where its music is', async () => {
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`)
      const tracks = await screen.findByRole('list', { name: 'Low Tide tracks' })
      expect(document.body.textContent).not.toMatch(machinery)
      expect(screen.getAllByRole('button', { name: 'Play Low Tide' })[0]).toBeEnabled()
      expect(within(tracks).getAllByRole('listitem').filter(row => row.getAttribute('aria-disabled'))).toHaveLength(0)
      expect(screen.queryByRole('button', { name: /Wantlist/ })).toBeNull()
    })

    it('plays a song that is not on the server yet after the spinner any song shows while it loads', async () => {
      const { services, socket } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      const edit = lowTide.discs[0].tracks[1]
      await userEvent.click(await screen.findByRole('button', { name: `Play ${edit.title}` }))
      await waitFor(() => expect(socket.session.current?.trackId).toBe(edit.id))
      const row = within(screen.getByRole('list', { name: 'Low Tide tracks' })).getAllByRole('listitem')[1]!
      expect(within(row).getByRole('status', { name: 'Loading' })).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(/preparing/i)
    })

    it('saves the album with the heart at once, and takes it out again', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await userEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      expect(api.userdata.like).toHaveBeenCalledWith('album', lowTide.id)
      expect(await screen.findByText('Saved to your library')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Remove from library' }))
      expect(await screen.findByRole('button', { name: 'Save to library' })).toBeInTheDocument()
      expect(api.userdata.unlike).toHaveBeenCalledWith('album', lowTide.id)
    })

    it('has one menu entry that mirrors the heart, and no separate library button', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await screen.findByRole('list', { name: 'Low Tide tracks' })
      expect(screen.queryByRole('button', { name: /Add to library|Like Low Tide/ })).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'More options' }))
      const entries = (await screen.findAllByRole('menuitem')).map(item => item.textContent)
      expect(entries.filter(entry => /library|like/i.test(entry ?? ''))).toEqual(['Save to library'])
      await userEvent.click(screen.getByRole('menuitem', { name: 'Save to library' }))
      expect(api.userdata.like).toHaveBeenCalledWith('album', lowTide.id)
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'More options' }))
      expect(await screen.findByRole('menuitem', { name: 'Remove from library' })).toBeInTheDocument()
    })

    it('saves one song from its menu, worded like its heart', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      const edit = lowTide.discs[0].tracks[1]
      await userEvent.click(await screen.findByRole('button', { name: `More options for ${edit.title}` }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Save to library' }))
      expect(api.userdata.like).toHaveBeenCalledWith('track', edit.id)
      expect(await screen.findByText('Saved to your library')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: `Remove ${edit.title} from library` })).toBeInTheDocument()
    })

    it('refetches nothing for a heart: the server patches it and brings the lists that move', async () => {
      const { services, api } = fakeServices()
      const { queryClient } = renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await screen.findByRole('list', { name: 'Low Tide tracks' })
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
      const searches = api.search.catalog.mock.calls.length + api.search.library.mock.calls.length
      await userEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
      await waitFor(() => expect(api.userdata.like).toHaveBeenCalledWith('album', lowTide.id))
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      expect(invalidate).not.toHaveBeenCalled()
      expect(api.search.catalog.mock.calls.length + api.search.library.mock.calls.length).toBe(searches)
    })

    it('undoes a save from its toast', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await userEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
      expect(api.userdata.unlike).toHaveBeenCalledWith('album', lowTide.id)
      expect(await screen.findByRole('button', { name: 'Save to library' })).toBeInTheDocument()
    })

    // Regression: the optimistic save reached the heart through the query cache a timer later, so
    // a check right after the click (the providers e2e script) saw it empty, and the first frame
    // after a click showed the old heart. Only microtasks run between the click and the check:
    // what a browser finishes before it paints.
    it('fills the heart before any timer runs after the click', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      fireEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
      await act(() => Promise.resolve())
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      // And it stays filled once the cache has the save.
      expect(await screen.findByText('Saved to your library')).toBeInTheDocument()
      await waitFor(() => expect(api.userdata.like).toHaveBeenCalledWith('album', lowTide.id))
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Remove from library' }))
      await act(() => Promise.resolve())
      expect(screen.getByRole('button', { name: 'Save to library' })).toBeInTheDocument()
    })

    // Regression: an album page re-reads itself while its songs arrive; an answer sent before the
    // click landed after the optimistic save and emptied the heart until the next refetch.
    it('keeps the heart filled when a read sent before the click answers after it', async () => {
      const { services, api } = fakeServices()
      const { queryClient } = renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      const save = await screen.findByRole('button', { name: 'Save to library' })
      let answer: ((value: AlbumDetail) => void) | undefined
      api.catalog.album.mockImplementationOnce(() => new Promise<AlbumDetail>(resolve => { answer = resolve }))
      void queryClient.refetchQueries({ predicate: query => query.queryKey.includes(lowTide.id) })
      await waitFor(() => expect(answer).toBeDefined())
      fireEvent.click(save)
      await act(() => Promise.resolve())
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      await act(async () => answer!({ ...lowTide, liked: false }))
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
    })

    it('empties a heart filled at once when the server refuses', async () => {
      const { services, api } = fakeServices()
      api.userdata.like.mockRejectedValueOnce(new Error('No'))
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      fireEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
      await act(() => Promise.resolve())
      expect(await screen.findByText('Couldn’t save to your library')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save to library' })).toBeInTheDocument()
    })

    it('puts the heart back when the server refuses, and replaces the toast with one that says so', async () => {
      const { services, api } = fakeServices()
      api.userdata.like.mockRejectedValueOnce(new Error('No'))
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await userEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
      expect(await screen.findByText('Couldn’t save to your library')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save to library' })).toBeInTheDocument()
      expect(screen.queryByText('Saved to your library')).toBeNull()

      await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
      expect(await screen.findByText('Saved to your library')).toBeInTheDocument()
      expect(api.userdata.like).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      expect(screen.queryByText('Couldn’t save to your library')).toBeNull()
    })

    it('says a refused removal did not happen', async () => {
      const { services, api } = fakeServices()
      api.userdata.unlike.mockRejectedValueOnce(new Error('No'))
      renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
      await userEvent.click(await screen.findByRole('button', { name: 'Remove from library' }))
      expect(await screen.findByText('Couldn’t remove from your library')).toBeInTheDocument()
      expect(screen.queryByText('Removed from your library')).toBeNull()
      expect(screen.getByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    })

    it('says so when the album is saved, naming it', async () => {
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`)
      await userEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
      await waitFor(() => expect(toasts()).toContain('Saved to your libraryLow TideUndo'))
    })

    it('puts an album removed and then undone back where it was in Recently added', async () => {
      const { services, api } = fakeServices()
      const savedAt = '2026-10-01T12:00:00.000Z'
      api.userdata.unlike.mockResolvedValueOnce({ ok: true, savedAt })
      renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
      await userEvent.click(await screen.findByRole('button', { name: 'Remove from library' }))
      await userEvent.click(await screen.findByRole('button', { name: 'Undo' }))
      await waitFor(() => expect(api.userdata.like).toHaveBeenCalledWith('album', blueHour.id, { savedAt }))
      expect(await screen.findByRole('button', { name: 'Remove from library' })).toBeInTheDocument()
    })

    it('saves the song playing from the heart in Now Playing, its only library control', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await userEvent.click((await screen.findAllByRole('button', { name: 'Play Low Tide' }))[0]!)
      await userEvent.click(await screen.findByRole('button', { name: 'Open Now Playing' }))
      const nowPlaying = await screen.findByRole('dialog', { name: 'Now Playing' })
      expect(within(nowPlaying).queryByRole('button', { name: /Add to library/ })).toBeNull()
      const song = lowTide.discs[0].tracks[0]
      await userEvent.click(within(nowPlaying).getByRole('button', { name: `Save ${song.title} to library` }))
      expect(api.userdata.like).toHaveBeenCalledWith('track', song.id)
      expect(within(nowPlaying).getByRole('button', { name: `Remove ${song.title} from library` })).toBeInTheDocument()
    })

    // Regression: the player bar's heart was also named "Save to library", so with a song playing
    // the album page had two of them, and the first (the song's) was taken for the album's: the
    // providers e2e script saved the song, and the album was never saved or fetched.
    it('has one Save to library while a song plays, the album\'s, and it saves the album', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await userEvent.click((await screen.findAllByRole('button', { name: 'Play Low Tide' }))[0]!)
      const player = await screen.findByRole('region', { name: 'Player' })
      const song = lowTide.discs[0].tracks[0]
      expect(await within(player).findByRole('button', { name: `Save ${song.title} to library` })).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Save to library' })).toHaveLength(1)
      await userEvent.click(screen.getByRole('button', { name: 'Save to library' }))
      await waitFor(() => expect(api.userdata.like).toHaveBeenCalledWith('album', lowTide.id))
      expect(api.userdata.like).not.toHaveBeenCalledWith('track', expect.anything())
    })

    it('shows the viewer’s own save on music on this server, never hiding the heart', async () => {
      const { services, api } = fakeServices()
      renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
      // Blue Hour is the server's own and the viewer saved it too.
      await userEvent.click(await screen.findByRole('button', { name: 'Remove from library' }))
      expect(api.userdata.unlike).toHaveBeenCalledWith('album', blueHour.id)
      expect(screen.queryByRole('img', { name: 'On this server' })).toBeNull()
      expect(await screen.findByRole('button', { name: 'Save to library' })).toBeInTheDocument()
    })

    it('offers no playlist to add to before its songs are known', async () => {
      const { services, api } = fakeServices()
      api.catalog.album.mockResolvedValue({ ...lowTide, discs: [], trackCount: 0, ownedTrackCount: 0, durationMs: 0, detailPending: true })
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      await screen.findByRole('status', { name: 'Loading songs' })
      await userEvent.click(screen.getByRole('button', { name: 'More options' }))
      expect(await screen.findByRole('menuitem', { name: 'Add to playlist' })).toHaveAttribute('aria-disabled', 'true')
    })

    it('can be played before its songs are known, and plays once they arrive', async () => {
      const { services, api, socket } = fakeServices()
      const bare: AlbumDetail = { ...lowTide, discs: [], trackCount: 0, ownedTrackCount: 0, durationMs: 0, detailPending: true }
      api.catalog.album.mockResolvedValueOnce(bare)
      const { queryClient } = renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      expect(await screen.findByRole('status', { name: 'Loading songs' })).toBeInTheDocument()
      const play = screen.getAllByRole('button', { name: 'Play Low Tide' })[0]!
      await userEvent.click(play)
      expect(play).toHaveAttribute('aria-busy', 'true')
      expect(socket.session.current).toBeNull()
      await act(() => queryClient.invalidateQueries({ queryKey: ['album', lowTide.id] }))
      await waitFor(() => expect(socket.session.current?.trackId).toBe(lowTide.discs[0].tracks[0].id))
    })
  })

  describe('without a track list', () => {
    const bare: AlbumDetail = { ...lowTide, discs: [], trackCount: 0, ownedTrackCount: 0, durationMs: 0 }

    it('says no songs are listed when the server is not looking for them, and cannot be played', async () => {
      const { services, api } = fakeServices()
      api.catalog.album.mockResolvedValue(bare)
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
      expect(await screen.findByText('No songs listed')).toBeInTheDocument()
      expect(screen.queryByRole('status', { name: 'Loading songs' })).toBeNull()
      expect(screen.getAllByRole('button', { name: 'Play Low Tide' })[0]).toBeDisabled()
      expect(screen.queryByText(/0 songs/)).toBeNull()
    })

    it('stops showing the list as loading after a minute, and can check again', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        const { services, api } = fakeServices()
        api.catalog.album.mockResolvedValue({ ...bare, detailPending: true })
        renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
        expect(await screen.findByRole('status', { name: 'Loading songs' })).toBeInTheDocument()
        await act(() => vi.advanceTimersByTimeAsync(TRACK_LIST_WAIT_MS))
        expect(await screen.findByText('Still looking for the songs')).toBeInTheDocument()
        expect(screen.queryByRole('status', { name: 'Loading songs' })).toBeNull()
        let answer: (album: typeof lowTide) => void = () => {}
        api.catalog.album.mockImplementation(() => new Promise(resolve => { answer = resolve }))
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
        // Busy until the server answers, so a press is seen to do something.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).toHaveAttribute('aria-busy', 'true'))
        answer(lowTide)
        expect(await screen.findByRole('list', { name: 'Low Tide tracks' })).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('names a song\'s artists only where they are not the album\'s own, and has no artist column', async () => {
    const { services, api } = fakeServices()
    const tracks = blueHour.discs[0].tracks
    const guest = { id: '01a20236-8dd0-77ed-9c01-ab24582bf8cf', name: 'Guest Artist' }
    const featured = { ...tracks[1]!, artistCredit: `${blueHour.artistCredit} feat. ${guest.name}`, artists: [...tracks[1]!.artists, guest] }
    api.catalog.album.mockResolvedValue({ ...blueHour, discs: [{ ...blueHour.discs[0], tracks: [tracks[0]!, featured, ...tracks.slice(2)] }] })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    const list = await screen.findByRole('list', { name: 'Blue Hour tracks' })
    const rows = within(list).getAllByRole('listitem')
    expect(within(rows[0]!).queryByRole('link')).toBeNull()
    expect(within(rows[1]!).getByRole('link', { name: guest.name })).toBeInTheDocument()
    expect(screen.queryByText('Artist', { selector: 'span' })).toBeNull()
  })

  it('credits several artists as the credit reads, each a link', async () => {
    const { services, api } = fakeServices()
    const [mira, lune] = [blueHour.artists[0]!, slowMotion.artists[0]!]
    api.catalog.album.mockResolvedValue({ ...blueHour, artistCredit: `${mira.name} feat. ${lune.name}`, artists: [mira, lune] })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    const heading = await screen.findByRole('heading', { level: 1, name: 'Blue Hour' })
    const byline = heading.nextElementSibling as HTMLElement
    expect(byline.textContent).toBe(`${mira.name} feat. ${lune.name}`)
    expect(within(byline).getByRole('link', { name: lune.name })).toHaveAttribute('href', `/artist/${lune.id}`)
  })

  it('offers no “Go to album” on its own songs', async () => {
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`)
    const first = blueHour.discs[0].tracks[0]
    await userEvent.click(await screen.findByRole('button', { name: `More options for ${first.title}` }))
    const items = (await screen.findAllByRole('menuitem')).map(item => item.textContent)
    expect(items).not.toContain('Go to album')
    expect(items).toContain('Go to artist')
  })

  it('prints the release date as written, at the precision it has', async () => {
    const { services, api } = fakeServices()
    api.catalog.album.mockResolvedValueOnce({ ...blueHour, releaseDate: '1994-01-01' }).mockResolvedValueOnce({ ...slowMotion, releaseDate: '1984-09' })
    const { unmount } = renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    expect(await screen.findByText('Jan 1, 1994')).toBeInTheDocument()
    unmount()
    renderWithApp(<AppRoutes />, `/album/${slowMotion.id}`, services)
    expect(await screen.findByText('Sep 1984')).toBeInTheDocument()
  })

  it('ends with other versions of the album and more by its artist', async () => {
    const { services, api } = fakeServices()
    const mira = artistDetail(blueHour.artists[0]!.id)!
    const deluxe = { ...summary(blueHour), id: '00000000-0000-4000-8200-0000000000ee', title: 'Blue Hour (Deluxe Edition)' }
    api.catalog.artist.mockResolvedValue({ ...mira, albums: [deluxe, ...mira.albums] })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    const versions = await screen.findByRole('region', { name: 'Other versions' })
    expect(within(versions).getByRole('link', { name: 'Blue Hour (Deluxe Edition)' })).toHaveAttribute('href', `/album/${deluxe.id}`)
    const more = screen.getByRole('region', { name: `More by ${mira.name}` })
    const titles = within(more).getAllByRole('link').map(link => link.textContent).filter(title => title && title !== 'See all')
    // Albums and EPs before live albums and singles; never the album itself or a version of it.
    expect(titles).toEqual(['Paper Moons', 'Live at the Glasshouse', 'Low Tide'])
    expect(within(more).getByRole('link', { name: 'See all' })).toHaveAttribute('href', `/artist/${mira.id}`)
  })

  it('shows no song count in the preview while it knows none', async () => {
    renderWithApp(<AlbumPreview album={{ ...summary(blueHour), trackCount: 0 }} />)
    expect(await screen.findByRole('status', { name: 'Loading Blue Hour' })).toBeInTheDocument()
    expect(screen.queryByText(/0 songs/)).toBeNull()
    expect(screen.getByText('2025')).toBeInTheDocument()
  })

  describe('for a member who may not fetch music', () => {
    it('grays out what does not play and says how much does, in one line', async () => {
      renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, fakeServices({ user: robin }).services)
      const tracks = await screen.findByRole('list', { name: 'Blue Hour tracks' })
      expect(screen.getByText(/5 of 7 songs available/)).toBeInTheDocument()
      expect(within(tracks).getAllByRole('listitem').filter(row => row.getAttribute('title') === 'Not available')).toHaveLength(2)
    })

    it('cannot play an album nothing of which plays, and offers it to the Wantlist', async () => {
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, fakeServices({ user: robin }).services)
      await screen.findByRole('list', { name: 'Low Tide tracks' })
      expect(screen.getAllByRole('button', { name: 'Play Low Tide' })[0]).toBeDisabled()
      expect(screen.getByRole('button', { name: /Wantlist/ })).toBeInTheDocument()
      expect(document.body.textContent).not.toMatch(machinery)
    })

    it('says nothing of the Wantlist while the server has it off', async () => {
      renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, fakeServices({ user: robin, status: { wantlistEnabled: false } }).services)
      await screen.findByRole('list', { name: 'Low Tide tracks' })
      expect(screen.queryByText(/Wantlist/)).toBeNull()
      expect(screen.queryByRole('button', { name: /Wantlist/ })).toBeNull()
    })
  })

  it('opens Fix match from the menu for admins', async () => {
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Fix match…' }))
    expect(await screen.findByRole('heading', { name: 'Fix match' })).toBeInTheDocument()
  })

  it('has no Fix match for members', async () => {
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, fakeServices({ user: users[1] }).services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    expect(await screen.findByRole('menuitem', { name: 'Play next' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Fix match…' })).toBeNull()
  })
})
