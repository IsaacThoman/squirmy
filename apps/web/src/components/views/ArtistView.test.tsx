import type { ArtistDetail } from '@squirmy/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album, artistDetail, summary } from '@/fixtures/catalog'
import { currentUser } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const id = '00000000-0000-4000-8100-000000000001'

async function renderArtist(radio: boolean | undefined, { inLibrary = false, requester = true } = {}) {
  const fake = fakeServices({ user: requester ? currentUser : { ...currentUser, role: 'member', canAcquire: false } })
  fake.api.catalog.artist.mockResolvedValue({ ...artistDetail(id)!, inLibrary, radio })
  renderWithApp(<AppRoutes />, `/artist/${id}`, fake.services)
  await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })
  return screen.queryByRole('button', { name: 'Start Mira Vale radio' })
}

describe('artist radio', () => {
  it('is offered when the server says a radio starts, even with nothing in the library', async () => {
    expect(await renderArtist(true, { requester: false })).toBeInTheDocument()
  })

  it('is left out when the server says nothing plays, even for a requester', async () => {
    expect(await renderArtist(false)).toBeNull()
  })

  it('falls back to the library and the viewer for a server that does not say', async () => {
    expect(await renderArtist(undefined)).toBeInTheDocument()
  })

  it('falls back to the library for someone who may not fetch', async () => {
    expect(await renderArtist(undefined, { requester: false })).toBeNull()
  })
})

const blueHour = summary(album('blue-hour'))
const lowTide = summary(album('low-tide'))
const paperMoons = summary(album('paper-moons'))
// A record of another artist's that credits this one.
const slowMotion = summary(album('slow-motion'))

type Fake = ReturnType<typeof fakeServices>

async function renderPage(
  edit: (artist: ArtistDetail) => ArtistDetail,
  { requester = true, route = `/artist/${id}`, setup }: { requester?: boolean; route?: string; setup?: (fake: Fake) => void } = {},
) {
  const fake = fakeServices({ user: requester ? currentUser : { ...currentUser, role: 'member', canAcquire: false } })
  fake.api.catalog.artist.mockResolvedValue(edit(artistDetail(id)!))
  setup?.(fake)
  const rendered = renderWithApp(<AppRoutes />, route, fake.services)
  return { fake, ...rendered }
}

describe('artist sections', () => {
  it('lists works a composer contributed to and plays from that section', async () => {
    const track = album('blue-hour').discs[0].tracks[0]
    const { fake } = await renderPage(artist => ({ ...artist, topTracks: [], composedOrProduced: [track] }))
    const list = await screen.findByRole('list', { name: 'Composed / Produced' })
    expect(screen.queryByRole('list', { name: 'Top songs' })).toBeNull()
    await userEvent.click(within(list).getByRole('button', { name: `Play ${track.title}` }))
    await waitFor(() => expect(fake.socket.session.current?.trackId).toBe(track.id))
  })

  it('shows each section as one row, with See all when it has more than it shows', async () => {
    await renderPage(artist => ({
      ...artist,
      sections: [
        { key: 'album', title: 'Albums', total: 30, items: [blueHour] },
        { key: 'single', title: 'Singles', total: 1, items: [lowTide] },
        { key: 'appears_on', title: 'Appears on', total: 1, items: [slowMotion] },
        { key: 'remix', title: 'Remixes', total: 1, items: [paperMoons] },
      ],
    }))
    const albums = await screen.findByRole('region', { name: 'Albums' })
    expect(within(albums).getByRole('link', { name: 'Blue Hour' })).toBeInTheDocument()
    expect(within(albums).getByRole('link', { name: 'See all' })).toHaveAttribute('href', `/artist/${id}/releases/album`)
    expect(within(screen.getByRole('region', { name: 'Singles' })).queryByRole('link', { name: 'See all' })).toBeNull()
    // Someone else's record says whose it is.
    const appearsOn = screen.getByRole('region', { name: 'Appears on' })
    expect(within(appearsOn).getByText('Lune Park · 2024')).toBeInTheDocument()
    // A section this build does not know shows under the server's title, without a See all it could not page.
    expect(within(screen.getByRole('region', { name: 'Remixes' })).getByRole('link', { name: /^Paper Moons/ })).toBeInTheDocument()
  })

  it('groups the releases by type for a server that predates sections', async () => {
    await renderPage(artist => ({
      ...artist,
      sections: undefined,
      releaseCount: undefined,
      ownedReleaseCount: undefined,
      albums: [lowTide, blueHour, paperMoons],
      appearsOn: [slowMotion],
    }))
    expect(await screen.findByRole('region', { name: 'Albums' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'EPs' })).getByRole('link', { name: /^Paper Moons/ })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Singles' })).getByRole('link', { name: 'Low Tide' })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'Appears on' })).getByRole('link', { name: 'Slow Motion' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'See all' })).toBeNull()
    expect(screen.getByText('3 releases')).toBeInTheDocument()
  })

  it('counts the releases the server reports, not the ones it sent', async () => {
    await renderPage(artist => ({ ...artist, releaseCount: 40, ownedReleaseCount: 12 }), { requester: false })
    expect(await screen.findByText('12 of 40 releases available')).toBeInTheDocument()
  })

  it('shows the disambiguation, so artists of one name can be told apart', async () => {
    await renderPage(artist => ({ ...artist, disambiguation: 'Dream pop singer from Oslo', releaseCount: 40, ownedReleaseCount: 40 }))
    expect(await screen.findByText('Dream pop singer from Oslo · 40 releases')).toBeInTheDocument()
  })

  it('says the discography is still loading while the server fills it in', async () => {
    await renderPage(artist => ({ ...artist, detailPending: true }))
    expect(await screen.findByText('Loading discography…')).toHaveAttribute('role', 'status')
  })

  it('says nothing about loading once the discography is in', async () => {
    await renderPage(artist => artist)
    await screen.findByRole('region', { name: 'Albums' })
    expect(screen.queryByText('Loading discography…')).toBeNull()
  })
})

describe('see all', () => {
  it('pages one section as it scrolls and leads back to the artist', async () => {
    // jsdom lays nothing out; the grid renders the rows a window of this size shows.
    const height = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(900)
    onTestFinished(() => height.mockRestore())
    const { fake } = await renderPage(artist => ({ ...artist, sections: [{ key: 'album', title: 'Albums', total: 3, items: [blueHour] }] }), {
      route: `/artist/${id}/releases/album`,
      setup: fake => fake.api.catalog.artistReleases.mockImplementation(async (_artist: string, { cursor }: { section: string; cursor?: string }) => (
        cursor ? { items: [paperMoons], nextCursor: null } : { items: [blueHour, lowTide], nextCursor: 'next' }
      )),
    })
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Vale · Albums' })).toBeInTheDocument()
    expect(screen.getByText('3 releases')).toBeInTheDocument()
    const grid = await screen.findByRole('list', { name: 'Albums' })
    await waitFor(() => expect(within(grid).getByRole('link', { name: /^Paper Moons/ })).toBeInTheDocument())
    expect(within(grid).getByRole('link', { name: 'Blue Hour' })).toBeInTheDocument()
    expect(fake.api.catalog.artistReleases).toHaveBeenCalledWith(id, expect.objectContaining({ section: 'album', cursor: 'next' }))

    await userEvent.click(screen.getByRole('link', { name: 'Mira Vale' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })).toBeInTheDocument()
  })

  it('opens from the artist page', async () => {
    await renderPage(artist => ({ ...artist, sections: [{ key: 'album', title: 'Albums', total: 30, items: [blueHour] }] }))
    await userEvent.click(within(await screen.findByRole('region', { name: 'Albums' })).getByRole('link', { name: 'See all' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Mira Vale · Albums' })).toBeInTheDocument()
  })

  it('is nothing for a section the app does not know', async () => {
    await renderPage(artist => artist, { route: `/artist/${id}/releases/remix` })
    expect(await screen.findByText('Nothing here')).toBeInTheDocument()
  })
})

describe('the heart', () => {
  it('says beside the heart when the server refused to save the artist, and names them to screen readers', async () => {
    const fake = fakeServices()
    fake.api.catalog.artist.mockResolvedValue({ ...artistDetail(id)!, liked: false })
    fake.api.userdata.like.mockRejectedValueOnce(new Error('No'))
    renderWithApp(<AppRoutes />, `/artist/${id}`, fake.services)
    await userEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
    expect(fake.api.userdata.like).toHaveBeenCalledWith('artist', id)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Couldn’t save. Try again.')
    expect(screen.getByRole('button', { name: 'Save to library' })).toBeInTheDocument()
    expect(screen.getAllByRole('status').map(status => status.textContent)).toContain('Couldn’t save “Mira Vale” to your library. Try again.')
  })

  it('takes a refused save back out of the library, as well as the heart', async () => {
    const fake = fakeServices()
    fake.api.catalog.artist.mockResolvedValue({ ...artistDetail(id)!, liked: false, inLibrary: false })
    let refuse!: () => void
    fake.api.userdata.like.mockReturnValueOnce(new Promise<never>((_resolve, reject) => { refuse = () => reject(new Error('No')) }))
    renderWithApp(<AppRoutes />, `/artist/${id}`, fake.services)
    await userEvent.click(await screen.findByRole('button', { name: 'Save to library' }))
    expect(await screen.findByText('Artist · In your library')).toBeInTheDocument()
    refuse()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Couldn’t save. Try again.')
    expect(screen.queryByText('Artist · In your library')).not.toBeInTheDocument()
  })

})

describe('the artist page', () => {
  it('lists the top songs, then the releases, and the biography last', async () => {
    await renderPage(artist => artist)
    await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })
    const headings = (await screen.findAllByRole('heading', { level: 2 })).map(heading => heading.textContent)
    expect(headings[0]).toBe('Top songs')
    expect(headings.at(-1)).toBe('About')
    expect(headings.length).toBeGreaterThan(2)
  })

  it('shows three lines of a long biography until More shows the rest', async () => {
    // jsdom lays nothing out: the clamped paragraph says it holds more than it shows.
    const clamped = (element: HTMLElement, height: number) => (element.classList.contains('line-clamp-3') ? height : 0)
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return clamped(this, 120) })
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return clamped(this, 60) })
    onTestFinished(() => {
      scroll.mockRestore()
      client.mockRestore()
    })
    await renderPage(artist => artist)
    const bio = await screen.findByText(artistDetail(id)!.bio!)
    expect(bio).toHaveClass('line-clamp-3')
    const more = screen.getByRole('button', { name: 'More' })
    expect(more).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(more)
    expect(bio).not.toHaveClass('line-clamp-3')
    expect(screen.getByRole('button', { name: 'Less' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('offers no More for a biography three lines hold', async () => {
    await renderPage(artist => artist)
    expect(await screen.findByText(artistDetail(id)!.bio!)).toHaveClass('line-clamp-3')
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  })

  it('gives the release cards the album page’s menu', async () => {
    renderWithApp(<AppRoutes />, `/artist/${id}`)
    await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })
    await userEvent.click(screen.getAllByRole('button', { name: 'More options for Blue Hour' })[0]!)
    expect(await screen.findByRole('menuitem', { name: 'Remove from library' })).toBeEnabled()
    expect(screen.getByRole('menuitem', { name: 'Add to queue' })).toBeInTheDocument()
  })
})
