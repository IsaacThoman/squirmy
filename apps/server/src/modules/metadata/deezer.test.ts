import { describe, expect, it, vi } from 'vitest'
import { ProviderError } from '../../lib/http.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import * as deezer from './deezer.js'

const radiohead = 399
const okComputer = 14879699
const airbag = 138539971

describe('deezer', () => {
  useTestDatabase()
  const http = useHttpFixtures('deezer')

  it('searches artists, albums and tracks in parallel', async () => {
    const results = await deezer.search('radiohead ok computer', { limit: 5 })
    expect(http.requests.map((url) => new URL(url.split(' ')[1]!).pathname).sort()).toEqual(['/search/album', '/search/artist', '/search/track'])
    expect(results.albums[0]).toMatchObject({ id: okComputer, title: 'OK Computer', type: 'album', artist: { id: radiohead, name: 'Radiohead' } })
    expect(results.albums[0]!.coverUrl).toMatch(/1000x1000/)
    expect(results.tracks.length).toBeGreaterThan(0)
    for (const track of results.tracks) {
      expect(track.durationMs % 1000).toBe(0)
      expect(track.rank).toBeGreaterThan(0)
    }

    const artists = await deezer.search('radiohead', { types: ['artist'], limit: 3 })
    expect(artists.albums).toEqual([])
    expect(artists.artists[0]).toMatchObject({ id: radiohead, name: 'Radiohead', link: 'https://www.deezer.com/artist/399' })
    expect(artists.artists[0]!.imageUrl).toMatch(/^https:\/\/.*1000x1000/)
  })

  it('gets an album with UPC and its tracks in order', async () => {
    const album = await deezer.getAlbum(okComputer)
    expect(album).toMatchObject({ title: 'OK Computer', upc: '634904078164', type: 'album', trackCount: 12, artist: { name: 'Radiohead' } })
    expect(album!.tracks).toHaveLength(12)
    expect(album!.tracks[0]).toMatchObject({ id: airbag, title: 'Airbag', discNumber: 1, trackNumber: 1, isrc: 'GBAYE9701274', album: { id: okComputer } })
  })

  it('gets an artist with top tracks, related artists and albums', async () => {
    expect(await deezer.getArtist(radiohead)).toMatchObject({ name: 'Radiohead' })
    const top = await deezer.getArtistTopTracks(radiohead, { limit: 5 })
    expect(top).toHaveLength(5)
    expect(top.every((track) => track.album !== null)).toBe(true)
    const related = await deezer.getRelatedArtists(radiohead, { limit: 10 })
    expect(related.length).toBeGreaterThan(3)
    expect(related.map((artist) => artist.id)).not.toContain(radiohead)
    const albums = await deezer.getArtistAlbums(radiohead)
    expect(albums.length).toBeGreaterThan(20)
    expect(albums.find((album) => album.id === okComputer)).toMatchObject({ artist: { id: radiohead, name: 'Radiohead' } })
    expect(new Set(albums.map((album) => album.type))).toContain('single')
  })

  it('looks albums up by UPC and tracks by ISRC', async () => {
    const album = await deezer.getAlbumByUpc('634904078164')
    expect(album).toMatchObject({ id: okComputer, title: 'OK Computer', upc: '634904078164' })
    expect(album!.tracks).toHaveLength(12)
    expect(await deezer.getTrackByIsrc('GBAYE9701274')).toMatchObject({ title: 'Airbag', isrc: 'GBAYE9701274' })
    expect(await deezer.getAlbumByUpc('999999999999')).toBeNull()
  })

  it('returns null for Deezer "no data" errors', async () => {
    expect(await deezer.getAlbum(999999999999)).toBeNull()
  })

  it('retries quota errors and surfaces other API errors', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      const body = calls === 1 ? { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } } : { id: 1, name: 'Retried' }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    })
    expect(await deezer.getArtist(1)).toMatchObject({ name: 'Retried' })
    expect(calls).toBe(2)

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { type: 'ParameterException', message: 'Wrong parameter', code: 500 } }), { headers: { 'content-type': 'application/json' } }))
    await expect(deezer.getArtist(2)).rejects.toBeInstanceOf(ProviderError)

    // An error is not an answer: once Deezer is back, the next call gets the artist.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 2, name: 'Back' }), { headers: { 'content-type': 'application/json' } }))
    expect(await deezer.getArtist(2)).toMatchObject({ name: 'Back' })
  })

  it('follows next links to collect every page', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/artist/7')) return json({ id: 7, name: 'Paged' })
      if (url.includes('index=100')) return json({ data: [{ id: 2, title: 'Second', record_type: 'single' }] })
      return json({ data: [{ id: 1, title: 'First', record_type: 'album' }], next: 'https://api.deezer.com/artist/7/albums?limit=100&index=100' })
    })
    const albums = await deezer.getArtistAlbums(7)
    expect(albums.map((album) => [album.title, album.type, album.artist.name])).toEqual([['First', 'album', 'Paged'], ['Second', 'single', 'Paged']])
  })

  it('treats the blank placeholder image as no image', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ id: 3, name: 'No Picture', picture_xl: 'https://cdn-images.dzcdn.net/images/artist//1000x1000-000000-80-0-0.jpg' }), { headers: { 'content-type': 'application/json' } }))
    expect(await deezer.getArtist(3)).toMatchObject({ imageUrl: null })
  })

  it('returns nothing when Deezer is switched off', async () => {
    await updateServerSettings({ deezerEnabled: false })
    expect(await deezer.search('radiohead')).toEqual({ artists: [], albums: [], tracks: [] })
    expect(await deezer.getAlbum(okComputer)).toBeNull()
    expect(http.requests).toEqual([])
    await updateServerSettings({ deezerEnabled: true })
  })

  describe('soundtracks Deezer types as albums', () => {
    it.each([
      ['Gladiator: 20th Anniversary Edition', 173, []],
      ['The Dark Knight', null, ['Films/Games']],
      ['Interstellar (Original Motion Picture Soundtrack)', 132, []],
      ['Dune: Part Two (Original Score)', null, []],
      ['The Lion King (Music from the Motion Picture)', null, []],
      ['Cyberpunk 2077 (Original Video Game Soundtrack)', null, []],
    ] as const)('takes "%s" for one', (title, genreId, genres) => {
      expect(deezer.deezerSoundtrack({ title, genreId, genres })).toBe(true)
    })

    it('types the scores of a search as Deezer answers it, and leaves its singles singles', async () => {
      const { albums } = await deezer.search('gladiator hans zimmer', { types: ['album'], limit: 6 })
      const typed = Object.fromEntries(albums.map((album) => [album.title, album.type]))
      // Deezer's genre (Films/Games) with no word of a film in the title.
      expect(typed['Gladiator: 20th Anniversary Edition']).toBe('soundtrack')
      expect(typed['Gladiator - Music From The Motion Picture']).toBe('soundtrack')
      // Classical, and "Music from Gladiator" is not one of the phrases: an album, conservatively.
      expect(typed['Now We Are Free - Music from Gladiator']).toBe('album')
      expect(Object.entries(typed).filter(([title]) => title.includes('Theme from the Motion Picture')).every(([, type]) => type === 'single')).toBe(true)
    })

    it.each([
      ['Soundtrack to My Life', 116, ['Rap/Hip Hop']],
      ['More Music', 152, ['Rock']],
      ['Original Pirate Material', 116, []],
      ['The Score', 116, []],
    ] as const)('leaves "%s" an album', (title, genreId, genres) => {
      expect(deezer.deezerSoundtrack({ title, genreId, genres })).toBe(false)
    })
  })
})
