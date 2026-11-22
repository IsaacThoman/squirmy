import { mergeSearch } from '@squirmy/client-core'
import type { SearchResults, SearchTopResult, TrackSummary } from '@squirmy/contracts'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Bookmark, Disc3, House } from 'lucide-react'
import { useEffect, useState, type ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { album, artists, libraryAlbums, libraryArtists, libraryTracks, summary, track } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'
import { SearchDialog, type SearchChoice, type SearchDestination } from './SearchDialog'

const destinations: SearchDestination[] = [
  { label: 'Home', to: '/', icon: House },
  { label: 'Albums', to: '/library/albums', icon: Disc3 },
  { label: 'Wantlist', to: '/wantlist', icon: Bookmark },
]

const [miraVale, lunePark] = artists
const blueHour = summary(album('blue-hour'))
const lowTide = summary(album('low-tide'))
const nightSwimming = track('night-swimming')
/** Not in the library and not to be had: choosing it opens its album. */
const softSignalLive = track('soft-signal-live')

const requester = { role: 'admin', canAcquire: true } as const
/** The library's answer, or both answers, as the shell merges them. */
const merged = (library: SearchResults, catalog?: SearchResults) => mergeSearch(library, catalog, requester)
const withTop = (results: SearchResults, top: SearchTopResult) => merged({ ...results, top })

const foundAnswer: SearchResults = { artists: [miraVale, lunePark], albums: [blueHour, lowTide], tracks: [nightSwimming, softSignalLive], provider: null, top: null }
const found = merged(foundAnswer)
const everything = 'See all results for “night”'
const inOrder = ['Mira Vale Artist', 'Lune Park Artist', 'Blue Hour Album · Mira Vale', 'Low Tide Single · Mira Vale', 'Night Swimming Song · Mira Vale', 'Soft Signal (Live) Song · Mira Vale', everything]

type Props = Partial<ComponentProps<typeof SearchDialog>>

/** Holds the query, as the shell does. */
function Harness({ query: initial = '', onQueryChange, ...props }: Props) {
  const [query, setQuery] = useState(initial)
  return (
    <SearchDialog
      open
      onOpenChange={() => {}}
      results={null}
      loading={false}
      destinations={destinations}
      canPlay={(candidate: TrackSummary) => candidate.availability === 'server'}
      isDimmed={() => false}
      onChoose={() => {}}
      {...props}
      query={query}
      onQueryChange={next => {
        onQueryChange?.(next)
        setQuery(next)
      }}
    />
  )
}

function renderDialog(props: Props = {}) {
  const onChoose = vi.fn<(choice: SearchChoice) => void>()
  const onOpenChange = vi.fn<(open: boolean) => void>()
  const onQueryChange = vi.fn<(query: string) => void>()
  renderWithApp(<Harness onChoose={onChoose} onOpenChange={onOpenChange} onQueryChange={onQueryChange} {...props} />)
  return { onChoose, onOpenChange, onQueryChange, field: screen.getByRole('combobox', { name: 'Search' }) }
}

const options = () => screen.getAllByRole('option')
const expectOptions = (names: string[]) => {
  const shown = options()
  expect(shown).toHaveLength(names.length)
  names.forEach((name, index) => expect(shown[index]).toHaveAccessibleName(name))
}
/** The option the arrow keys are on: the one Enter chooses. */
const expectActive = (field: HTMLElement, index: number) => {
  const shown = options()
  expect(field).toHaveAttribute('aria-activedescendant', shown[index].id)
  expect(shown.map(option => option.getAttribute('aria-selected'))).toEqual(shown.map((_, at) => String(at === index)))
}

describe('SearchDialog', () => {
  it('is a dialog named Search with the cursor in its field', () => {
    const { field } = renderDialog()
    expect(screen.getByRole('dialog', { name: 'Search' })).toBeInTheDocument()
    expect(field).toHaveFocus()
    expect(field).toHaveValue('')
  })

  it('lists the places to go under “Go to” before anything is typed', () => {
    const { field } = renderDialog()
    expect(within(screen.getByRole('listbox', { name: 'Go to' })).getAllByRole('option')).toHaveLength(3)
    expectOptions(['Home', 'Albums', 'Wantlist'])
    expect(screen.getByText('Go to')).toBeInTheDocument()
    expect(field).toHaveAttribute('aria-expanded', 'true')
    expect(field).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
    expectActive(field, 0)
  })

  it('still lists the places to go for a query of spaces', () => {
    renderDialog({ query: '   ', results: found })
    expectOptions(['Home', 'Albums', 'Wantlist'])
  })

  it('without a ranking from the server, lists artists, then albums, then songs, then “Search everything for …”', () => {
    renderDialog({ query: 'night', results: found })
    expect(screen.getByRole('listbox', { name: 'Results' })).toBeInTheDocument()
    expectOptions(inOrder)
    expect(screen.queryByText('Go to')).not.toBeInTheDocument()
  })

  it.each([
    ['an album', { type: 'album', id: lowTide.id }, 3],
    ['a song', { type: 'track', id: nightSwimming.id }, 4],
    ['an artist', { type: 'artist', id: lunePark.id }, 1],
  ] as const)('puts the server’s best match first when it is %s', (_kind, top, from) => {
    renderDialog({ query: 'night', results: withTop(foundAnswer, top) })
    expectOptions([inOrder[from], ...inOrder.slice(0, from), ...inOrder.slice(from + 1)])
  })

  it.each([
    ['is already first', { type: 'artist', id: miraVale.id }],
    ['is not in the answer', { type: 'track', id: track('amber').id }],
  ] as const)('keeps the order when the best match %s', (_case, top) => {
    renderDialog({ query: 'night', results: withTop(foundAnswer, top) })
    expectOptions(inOrder)
  })

  const manyAnswer: SearchResults = { artists: libraryArtists.slice(0, 5), albums: libraryAlbums.slice(0, 6), tracks: libraryTracks.slice(0, 8), provider: null }
  const many = merged(manyAnswer)
  const kinds = () => options().slice(0, -1).map(option => (option.textContent.includes('Song · ') ? 'song' : option.textContent.includes('Artist') ? 'artist' : 'album'))

  it('shows the ten best results at most, then the way to the rest', () => {
    renderDialog({ query: 'a', results: many })
    expect(kinds()).toEqual([...Array<string>(5).fill('artist'), ...Array<string>(5).fill('album')])
    expect(options().at(-1)).toHaveAccessibleName('See all results for “a”')
  })

  it('lists kinds mixed in the order the server ranked them', () => {
    const ranked = merged({ ...foundAnswer, ranked: [
      { type: 'track', id: nightSwimming.id, score: 0.9 },
      { type: 'album', id: lowTide.id, score: 0.8 },
      { type: 'artist', id: lunePark.id, score: 0.7 },
    ] })
    renderDialog({ query: 'night', results: ranked })
    // What the server did not rank follows, as an older server's answer would show.
    expectOptions([inOrder[4], inOrder[3], inOrder[1], inOrder[0], inOrder[2], inOrder[5], everything])
  })

  it.each([
    ['a song', { type: 'track', id: many.tracks[7].id }, `${many.tracks[7].title} Song · ${many.tracks[7].artistCredit}`],
    ['an album', { type: 'album', id: many.albums[5].id }, `${many.albums[5].title} Album · ${many.albums[5].artistCredit}`],
    ['an artist', { type: 'artist', id: many.artists[4].id }, `${many.artists[4].name} Artist`],
  ] as const)('leads with the best match when it is %s further down the answer than the dialog shows', (_kind, top, name) => {
    renderDialog({ query: 'a', results: withTop(manyAnswer, top) })
    expect(options()[0]).toHaveAccessibleName(name)
    expect(screen.getAllByRole('option', { name })).toHaveLength(1)
    expect(options()).toHaveLength(11)
  })

  it('offers only “Search everything for …” while the first answer is on its way', () => {
    renderDialog({ query: ' night ', results: null, loading: true })
    expectOptions([everything])
    expect(screen.getByRole('status', { name: 'Searching' })).toBeInTheDocument()
  })

  it('does not say it is searching once the answer is in', () => {
    renderDialog({ query: 'night', results: found })
    expect(screen.queryByRole('status', { name: 'Searching' })).not.toBeInTheDocument()
  })

  it('moves the active option with the arrow keys and stops at both ends', async () => {
    const { field } = renderDialog()
    await userEvent.keyboard('{ArrowUp}')
    expectActive(field, 0)
    await userEvent.keyboard('{ArrowDown}')
    expectActive(field, 1)
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
    expectActive(field, 2)
    await userEvent.keyboard('{ArrowUp}')
    expectActive(field, 1)
    expect(field).toHaveFocus()
  })

  it('makes the option under the pointer the active one', async () => {
    const { field } = renderDialog({ query: 'night', results: found })
    await userEvent.hover(options()[3])
    expectActive(field, 3)
  })

  it('chooses the active option with Enter', async () => {
    const { onChoose } = renderDialog({ query: 'night', results: withTop(foundAnswer, { type: 'album', id: lowTide.id }) })
    await userEvent.keyboard('{Enter}')
    expect(onChoose).toHaveBeenLastCalledWith({ kind: 'result', item: { type: 'album', album: lowTide } })
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onChoose).toHaveBeenLastCalledWith({ kind: 'result', item: { type: 'artist', artist: miraVale } })
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
    expect(onChoose).toHaveBeenLastCalledWith({ kind: 'result', item: { type: 'track', track: nightSwimming } })
    expect(onChoose).toHaveBeenCalledTimes(3)
  })

  it('searches everything for the query, without the spaces around it, from the last option', async () => {
    const { onChoose } = renderDialog({ query: '  night ', results: found })
    await userEvent.keyboard('{ArrowUp}'.repeat(2) + '{ArrowDown}'.repeat(inOrder.length) + '{Enter}')
    expect(onChoose).toHaveBeenCalledWith({ kind: 'all', query: 'night' })
  })

  it('chooses a place to go with Enter or a click', async () => {
    const { onChoose } = renderDialog()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(onChoose).toHaveBeenLastCalledWith({ kind: 'destination', destination: destinations[1] })
    await userEvent.click(screen.getByRole('option', { name: 'Wantlist' }))
    expect(onChoose).toHaveBeenLastCalledWith({ kind: 'destination', destination: destinations[2] })
  })

  it('chooses a result with a click', async () => {
    const { onChoose } = renderDialog({ query: 'night', results: found })
    await userEvent.click(screen.getByRole('option', { name: 'Blue Hour Album · Mira Vale' }))
    expect(onChoose).toHaveBeenCalledWith({ kind: 'result', item: { type: 'album', album: blueHour } })
    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it('says Play on a song that can play and Open on everything else', async () => {
    renderDialog({ query: 'night', results: found })
    const hint = async (name: string) => {
      const option = screen.getByRole('option', { name: new RegExp(`^${name}`) })
      await userEvent.hover(option)
      return within(option)
    }
    expect((await hint('Night Swimming')).getByText('Play')).toBeInTheDocument()
    // Only the active option carries a hint.
    expect(screen.getAllByText(/^(Play|Open)$/)).toHaveLength(1)
    expect((await hint('Soft Signal \\(Live\\)')).getByText('Open')).toBeInTheDocument()
    expect((await hint('Mira Vale')).getByText('Open')).toBeInTheDocument()
    expect((await hint('Blue Hour')).getByText('Open')).toBeInTheDocument()
    const all = await hint('See all results')
    expect(all.queryByText('Play')).not.toBeInTheDocument()
    expect(all.queryByText('Open')).not.toBeInTheDocument()
  })

  it('asks the caller whether a song can play', async () => {
    const canPlay = vi.fn((candidate: TrackSummary) => candidate.id === softSignalLive.id)
    renderDialog({ query: 'night', results: found, canPlay })
    await userEvent.hover(screen.getByRole('option', { name: /^Soft Signal/ }))
    expect(within(screen.getByRole('option', { name: /^Soft Signal/ })).getByText('Play')).toBeInTheDocument()
    await userEvent.hover(screen.getByRole('option', { name: /^Night Swimming/ }))
    expect(within(screen.getByRole('option', { name: /^Night Swimming/ })).getByText('Open')).toBeInTheDocument()
  })

  it('reports what is typed and goes back to the first option', async () => {
    const { field, onQueryChange } = renderDialog({ query: 'nigh', results: found })
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expectActive(field, 2)
    await userEvent.type(field, 't')
    expect(onQueryChange).toHaveBeenLastCalledWith('night')
    expect(field).toHaveValue('night')
    expectActive(field, 0)
  })

  it('keeps the picked row picked when the catalog’s results join the list', async () => {
    const catalog: SearchResults = { artists: [], albums: [summary(album('afterimage'))], tracks: [track('amber')], provider: 'deezer', top: { type: 'track', id: track('amber').id, score: 1 } }
    // The dialog is modal, so the answer arrives from outside it, as the shell's would.
    const server = { answer: () => {} }
    function Growing() {
      const [results, setResults] = useState(found)
      useEffect(() => { server.answer = () => setResults(merged(foundAnswer, catalog)) })
      return <Harness query="night" results={results} />
    }
    renderWithApp(<Growing />)
    const field = screen.getByRole('combobox', { name: 'Search' })
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName('Blue Hour Album · Mira Vale')
    act(() => server.answer())
    expect(screen.getByRole('option', { name: /^Amber/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { selected: true })).toHaveAccessibleName('Blue Hour Album · Mira Vale')
    expect(field).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { selected: true }).id)
  })

  it('cuts a pasted query at 200 characters', async () => {
    const { field, onQueryChange } = renderDialog()
    await userEvent.click(field)
    await userEvent.paste('a'.repeat(250))
    expect(onQueryChange).toHaveBeenLastCalledWith('a'.repeat(200))
  })

  it('asks to close on Escape', async () => {
    const { onOpenChange, onChoose } = renderDialog()
    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('shows nothing while closed', () => {
    renderWithApp(<Harness open={false} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })
})
