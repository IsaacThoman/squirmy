import { SearchResults } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { likes, recordingArtists, recordings } from '../../database/schema.js'
import { creditKey } from '../../lib/text.js'
import { body, signIn } from '../../test/api.js'
import { createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'

describe('GET /search/library', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  let other: Awaited<ReturnType<typeof signIn>>
  const intros: string[] = []

  const search = async (q: string, as = user) =>
    body(await app.inject({ url: `/api/v1/search/library?q=${encodeURIComponent(q)}`, headers: as.headers }), SearchResults)
  const titles = (items: { title: string }[]) => items.map((item) => item.title)

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    other = await signIn()
    const radiohead = await createArtist({ name: 'Radiohead' })
    await createAlbum({
      title: 'OK Computer', artist: radiohead, owned: true,
      tracks: [{ title: 'Airbag' }, { title: 'Paranoid Android' }, { title: 'Karma Police' }, { title: 'Lucky' }, { title: 'No Surprises' }],
    })
    await createAlbum({ title: 'Kid A', artist: radiohead, owned: true, tracks: [{ title: 'Everything in Its Right Place' }, { title: 'Kid A' }] })
    // Catalog only: never in library results.
    await createAlbum({ title: 'Pablo Honey', artist: radiohead, tracks: [{ title: 'Creep' }, { title: 'Karma Police (Live)' }] })
    await createAlbum({ title: 'Lemonade', artist: await createArtist({ name: 'Beyoncé' }), owned: true, tracks: [{ title: 'Formation' }] })
    await createAlbum({ title: 'Ágætis byrjun', artist: await createArtist({ name: 'Sigur Rós' }), owned: true, tracks: [{ title: 'Svefn-g-englar' }] })
    await createAlbum({ title: '無罪モラトリアム', artist: await createArtist({ name: '椎名林檎' }), owned: true, tracks: [{ title: '丸の内サディスティック' }] })
    const ram = await createAlbum({ title: 'Random Access Memories', artist: await createArtist({ name: 'Daft Punk' }), owned: true, tracks: [{ title: 'Get Lucky' }] })
    const credit = 'Daft Punk feat. Pharrell Williams & Nile Rodgers'
    await db.update(recordings).set({ artistCredit: credit, matchKey: creditKey(credit, 'Get Lucky') }).where(eq(recordings.id, ram.tracks[0]!.recordingId))
    // Two tracks that tie on text, for the per-user tie-breaks.
    for (const name of ['Alpha Band', 'Beta Band']) {
      const album = await createAlbum({ title: `${name} Live`, artist: await createArtist({ name }), owned: true, tracks: [{ title: 'Intro' }] })
      intros.push(album.tracks[0]!.recordingId)
    }
  })
  afterAll(async () => {
    await app.close()
  })

  it('finds artists, albums and tracks of the library, best first', async () => {
    const results = await search('radiohead')
    expect(results.provider).toBeNull()
    expect(results.artists.map((artist) => [artist.name, artist.inLibrary])).toEqual([['Radiohead', true]])
    expect(titles(results.albums).sort()).toEqual(['Kid A', 'OK Computer'])
    expect(results.albums.every((album) => album.availability === 'full')).toBe(true)
    expect(results.tracks).toHaveLength(7)
    expect(results.tracks.every((track) => track.availability === 'server' && track.artistCredit === 'Radiohead')).toBe(true)
  })

  it('leaves out music the user does not own', async () => {
    expect(await search('pablo honey')).toMatchObject({ artists: [], albums: [], tracks: [] })
    expect(titles((await search('karma')).tracks)).toEqual(['Karma Police'])
  })

  it('ranks an exact title first, then prefixes, then similar titles', async () => {
    expect(titles((await search('lucky')).tracks)).toEqual(['Lucky', 'Get Lucky'])
    expect(titles((await search('kid a')).albums)[0]).toBe('Kid A')
    expect(titles((await search('para')).tracks)).toEqual(['Paranoid Android'])
  })

  it('names the best match across kinds as top', async () => {
    const top = async (q: string) => {
      const results = await search(q)
      const all = [...results.artists.map((item) => ({ ...item, title: item.name })), ...results.albums, ...results.tracks]
      return results.top && [results.top.type, all.find((item) => item.id === results.top!.id)!.title]
    }
    const scored = async (q: string) => (await search(q)).top?.score
    expect(await top('radiohead')).toEqual(['artist', 'Radiohead'])
    expect(await top('ok computer')).toEqual(['album', 'OK Computer'])
    // An album and its title track tie on text; the album leads.
    expect(await top('kid a')).toEqual(['album', 'Kid A'])
    expect(await top('karma police')).toEqual(['track', 'Karma Police'])
    expect(await top('radiohead lucky')).toEqual(['track', 'Lucky'])
    expect(await top('para')).toEqual(['track', 'Paranoid Android'])
    // A typo one character away still leads with the artist, as streaming apps do.
    expect(await top('radiohed')).toEqual(['artist', 'Radiohead'])
    expect(await top('paranoid andriod')).toBeNull()
    // Scored on the same scale as the catalog's top result, so a client can pick between them.
    expect(await scored('radiohead')).toBe(3)
    expect(await scored('radiohead ok computer')).toBe(3)
    expect(await scored('para')).toBe(1)
    expect(await scored('radiohed')).toBe(1)
  })

  it('works from the second character', async () => {
    expect(titles((await search('ok')).albums)).toEqual(['OK Computer'])
    expect(await search('o')).toEqual({ artists: [], albums: [], tracks: [], provider: null, top: null })
  })

  it('tolerates typos', async () => {
    expect((await search('radiohed')).artists.map((artist) => artist.name)).toEqual(['Radiohead'])
    expect(titles((await search('paranoid andriod')).tracks)[0]).toBe('Paranoid Android')
    expect(titles((await search('ok computr')).albums)[0]).toBe('OK Computer')
  })

  it('ignores case, punctuation and diacritics', async () => {
    expect((await search('BEYONCE')).artists.map((artist) => artist.name)).toEqual(['Beyoncé'])
    expect((await search('sigur ros')).artists.map((artist) => artist.name)).toEqual(['Sigur Rós'])
    expect(titles((await search('agaetis')).albums)).toEqual(['Ágætis byrjun'])
    expect(titles((await search('svefn g englar')).tracks)).toEqual(['Svefn-g-englar'])
  })

  it('finds names in non-Latin scripts', async () => {
    const results = await search('椎名')
    expect(results.artists.map((artist) => artist.name)).toEqual(['椎名林檎'])
    expect(titles(results.albums)).toEqual(['無罪モラトリアム'])
    expect(titles(results.tracks)).toEqual(['丸の内サディスティック'])
    expect(titles((await search('丸の内')).tracks)).toEqual(['丸の内サディスティック'])
  })

  it('understands "artist title" and "title artist" queries', async () => {
    expect(titles((await search('radiohead karma')).tracks)[0]).toBe('Karma Police')
    expect(titles((await search('karma police radiohead')).tracks)[0]).toBe('Karma Police')
    expect(titles((await search('radiohead kid a')).albums)[0]).toBe('Kid A')
    // The credit carries a featured artist; the primary artist still counts.
    expect(titles((await search('daft punk get lucky')).tracks)[0]).toBe('Get Lucky')
  })

  it("breaks ties with the user's plays and likes", async () => {
    const [alpha, beta] = intros
    const order = async (as = user) => (await search('intro', as)).tracks.map((track) => track.id)
    expect(await order()).toEqual([alpha, beta])

    await db.insert(likes).values({ userId: user.id, entityType: 'recording', entityId: beta! })
    expect(await order()).toEqual([beta, alpha])
    await createPlay({ userId: user.id, recordingId: alpha! })
    expect(await order()).toEqual([alpha, beta])
    // Another user's history changes nothing for them.
    expect(await order(other)).toEqual([alpha, beta])
    await createPlay({ userId: other.id, recordingId: beta! })
    expect(await order(other)).toEqual([beta, alpha])

    await createPlay({ userId: user.id, recordingId: beta! })
    await createPlay({ userId: user.id, recordingId: beta! })
    expect((await search('band')).artists.map((artist) => artist.name)).toEqual(['Beta Band', 'Alpha Band'])
  })

  it('leads with an album whose title starts with an article the query left out', async () => {
    const store = await createAlbum({ title: 'The Money Store', artist: await createArtist({ name: 'Death Grips' }), owned: true, tracks: [{ title: 'Get Got' }] })
    expect((await search('money store')).top).toEqual({ type: 'album', id: store.albumId, score: 2 })
    expect((await search('the money store')).top).toEqual({ type: 'album', id: store.albumId, score: 3 })
  })

  it('counts a track credited to an artist as theirs', async () => {
    const guest = await createArtist({ name: 'Pharrell Williams' })
    const [getLucky] = await db.select().from(recordings).where(eq(recordings.title, 'Get Lucky'))
    await db.insert(recordingArtists).values({ recordingId: getLucky!.id, position: 1, artistId: guest.id, creditedName: guest.name })
    expect((await search('pharrell')).artists.map((artist) => artist.name)).toEqual(['Pharrell Williams'])
  })
})
