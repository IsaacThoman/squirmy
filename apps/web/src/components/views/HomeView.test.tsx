import type { HomeResponse } from '@squirmy/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album, artists, home, mixes, personalHome, summary, track } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

function renderHome(response: HomeResponse) {
  const fake = fakeServices()
  fake.api.catalog.home.mockResolvedValue(response)
  renderWithApp(<AppRoutes />, '/', fake.services)
  return fake
}

describe('personal home', () => {
  it('asks for the personal layout in the device’s time zone', async () => {
    const fake = renderHome(personalHome)
    await screen.findByRole('region', { name: 'Jump back in' })
    expect(fake.api.catalog.home).toHaveBeenCalledWith({ layout: 'personal', tz: Intl.DateTimeFormat().resolvedOptions().timeZone })
  })

  it('jumps back into albums, mixes, playlists, radios and Liked Songs, each with its own card', async () => {
    renderHome(personalHome)
    const rail = await screen.findByRole('region', { name: 'Jump back in' })
    const links = within(rail).getAllByRole('link')
    expect(links.map(link => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Blue Hour', `/album/${album('blue-hour').id}`],
      [mixes[1]!.name, `/mix/${mixes[1]!.id}`],
      ['After Dark', expect.stringMatching(/^\/playlist\//)],
      [`${artists[0]!.name} Radio`, `/artist/${artists[0]!.id}`],
      ['Liked Songs', '/liked'],
    ])
    expect(within(rail).getByText('Radio')).toBeInTheDocument()
  })

  it('plays a mix from its card as a whole, with the mix as its context', async () => {
    const fake = renderHome(personalHome)
    const rail = await screen.findByRole('region', { name: 'Made for you' })
    expect(within(rail).getAllByRole('link').map(link => link.textContent)).toEqual(mixes.map(mix => mix.name))
    // The cover says which mix it is, apart from the playlists.
    expect(within(rail).getByText('Mix 1')).toBeInTheDocument()
    await userEvent.click(within(rail).getByRole('button', { name: `Play ${mixes[0]!.name}` }))
    await waitFor(() => expect(fake.socket.commands.find(command => command.type === 'playTracks')).toMatchObject({
      context: { type: 'mix', id: mixes[0]!.id, title: mixes[0]!.name },
      startedFrom: 'collection',
    }))
    expect(fake.api.radio.mix).toHaveBeenCalledWith(mixes[0]!.id)
  })

  it('starts a radio again from its card', async () => {
    const fake = renderHome(personalHome)
    const rail = await screen.findByRole('region', { name: 'Jump back in' })
    await userEvent.click(within(rail).getByRole('button', { name: `Play ${artists[0]!.name} Radio` }))
    await waitFor(() => expect(fake.api.radio.artist).toHaveBeenCalledWith(artists[0]!.id))
  })

  it('shows artist rails without a See all, since no page holds more of them', async () => {
    renderHome(personalHome)
    const because = await screen.findByRole('region', { name: `Because you listened to ${artists[0]!.name}` })
    expect(within(because).queryByRole('link', { name: /see all/i })).toBeNull()
    expect(screen.getByRole('region', { name: 'Your top artists' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Rediscover' })).toBeInTheDocument()
  })

  it('leaves out a kind of rail it does not know', async () => {
    renderHome({ sections: [
      { kind: 'shelves', id: 'future', title: 'From a newer server', shelves: [] } as never,
      ...personalHome.sections,
    ] })
    await screen.findByRole('region', { name: 'Jump back in' })
    expect(screen.queryByRole('heading', { name: 'From a newer server' })).toBeNull()
  })
})

describe('mix page', () => {
  it('shows the mix read-only and plays or shuffles it from its menu', async () => {
    const fake = fakeServices()
    const mix = mixes[0]!
    renderWithApp(<AppRoutes />, `/mix/${mix.id}`, fake.services)
    expect(await screen.findByRole('heading', { level: 1, name: mix.name })).toBeInTheDocument()
    expect(screen.getByText('Mix', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByText(mix.description)).toBeInTheDocument()
    const list = screen.getByRole('list', { name: `${mix.name} tracks` })
    expect(within(list).getAllByRole('listitem')).toHaveLength(mix.tracks.length)
    // Read-only: no reordering or removing songs.
    expect(screen.queryByRole('button', { name: /^Move/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'More options' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Shuffle' }))
    await waitFor(() => expect(fake.socket.commands.find(command => command.type === 'playTracks')).toMatchObject({
      context: { type: 'mix', id: mix.id, title: mix.name },
      shuffle: true,
    }))
  })

  it('says a mix that is gone is not here', async () => {
    renderWithApp(<AppRoutes />, '/mix/00000000-0000-4000-8600-0000000000ff', fakeServices().services)
    expect(await screen.findByRole('heading', { name: 'Nothing here' })).toBeInTheDocument()
  })
})

describe('home', () => {
  it('shows the sections in the order the server sends them', async () => {
    const reversed = { sections: [...home.sections].reverse() }
    renderHome(reversed)
    await screen.findByRole('heading', { level: 2, name: reversed.sections[0]!.title })
    const shown = screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent).filter(title => reversed.sections.some(section => section.title === title))
    expect(shown).toEqual(reversed.sections.map(section => section.title))
  })

  it('shows every recently played album in its rail, in server order', async () => {
    renderHome(home)
    const played = home.sections[0]!
    if (played.kind !== 'albums') throw new Error('The fixture leads with recently played albums')
    const rail = await screen.findByRole('region', { name: played.title })
    const cards = within(rail).getAllByRole('link').map(link => link.textContent)
    expect(cards).toEqual(played.albums.map(item => item.title))
    expect(screen.queryByRole('region', { name: 'Featured' })).toBeNull()
  })

  it.each([
    ['recently-played', 'Recently played'],
    ['recently-added', 'Recently added'],
  ])('keeps %s visible when it has only one album', async (id, title) => {
    renderHome({ sections: [
      { kind: 'albums', id, title, albums: [summary(album('low-tide'))] },
      { kind: 'tracks', id: 'most-played', title: 'Most played', tracks: [track('amber')] },
    ] })
    const rail = await screen.findByRole('region', { name: title })
    expect(within(rail).getByRole('link', { name: 'Low Tide' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Most played' })).toBeInTheDocument()
    expect(screen.queryByText('Start listening')).toBeNull()
  })

  it('points a requester at search when there is nothing yet', async () => {
    renderHome({ sections: [{ kind: 'albums', id: 'recently-added', title: 'Recently added', albums: [] }] })
    expect(await screen.findByRole('heading', { name: 'Start listening' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Find music' })).toHaveAttribute('href', '/search')
  })
})

describe('library', () => {
  it('explains what the library holds when it is empty', async () => {
    const fake = fakeServices()
    fake.api.catalog.albums.mockResolvedValue({ items: [], nextCursor: null })
    renderWithApp(<AppRoutes />, '/library/albums', fake.services)
    expect(await screen.findByText(/^Albums and songs you save show up here.*tap the heart\.$/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Find music' })).toHaveAttribute('href', '/search')
  })

  it('lists artists with no sort the server would ignore, and no genre', async () => {
    renderWithApp(<AppRoutes />, '/library/artists')
    await screen.findByRole('list', { name: 'Artists' })
    expect(screen.queryByRole('combobox', { name: 'Sort by' })).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Genre' })).toBeNull()
  })

  it('links Recently added to all of the server’s albums', async () => {
    renderHome(home)
    await screen.findByRole('heading', { level: 2, name: 'Recently added' })
    expect(screen.getAllByRole('link').filter(link => link.getAttribute('href') === '/collection?filter=albums')).toHaveLength(1)
  })
})
