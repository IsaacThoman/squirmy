import { SearchResults } from '@squirmy/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, likes, recordingArtists, recordings } from '../../database/schema.js'
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
    user = await signIn({ settings: { libraryIncludesServerMusic: true } })
    other = await signIn({ settings: { libraryIncludesServerMusic: true } })
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

  it('matches Library membership with or without server music and keeps global lookup available', async () => {
    const savesOnly = await signIn({ settings: { libraryIncludesServerMusic: false } })
    const collected = await createAlbum({
      title: 'Scope Collection Album', artist: await createArtist({ name: 'Scope Collection Artist' }),
      owned: true, tracks: [{ title: 'Scope Collection Track' }],
    })
    const cached = await createAlbum({
      title: 'Scope Cached Album', artist: await createArtist({ name: 'Scope Cached Artist' }),
      owned: true, source: 'provider:fixture', tracks: [{ title: 'Scope Cached Track' }],
    })
    const ids = (results: SearchResults) => [results.artists, results.albums, results.tracks].map((items) => items.map(({ id }) => id))
    const matches = (one: typeof collected) => [[one.artist.id], [one.albumId], [one.tracks[0]!.recordingId]]
    expect(ids(await search('scope collection', user))).toEqual(matches(collected))
    expect(ids(await search('scope collection', savesOnly))).toEqual([[], [], []])
    expect(ids(await search('scope cached', user))).toEqual([[], [], []])
    const global = await app.inject({ url: '/api/v1/search/library?q=scope+collection&scope=server', headers: savesOnly.headers })
    expect(ids(body(global, SearchResults))).toEqual(matches(collected))

    await db.insert(likes).values({ userId: savesOnly.id, entityType: 'album', entityId: cached.albumId })
    expect(ids(await search('scope cached', savesOnly))).toEqual(matches(cached))
    expect(ids(await search('scope cached', user))).toEqual([[], [], []])
  })

  it('keeps a search inside a genre: albums of it, their songs and their artists', async () => {
    const [inGenre, outside] = [
      await createAlbum({ title: 'Genre Search Inside', artist: await createArtist({ name: 'Genre Act One' }), owned: true, tracks: [{ title: 'Genre Search Song' }] }),
      await createAlbum({ title: 'Genre Search Outside', artist: await createArtist({ name: 'Genre Act Two' }), owned: true, tracks: [{ title: 'Genre Search Song Too' }] }),
    ]
    await db.update(albums).set({ genres: ['Electronic'] }).where(eq(albums.id, inGenre.albumId))
    await db.update(albums).set({ genres: ['Rock'] }).where(eq(albums.id, outside.albumId))
    const scoped = (q: string) => app.inject({ url: `/api/v1/search/library?q=${encodeURIComponent(q)}&genre=electronic`, headers: user.headers })
    expect(titles((await search('genre search')).albums).sort()).toEqual(['Genre Search Inside', 'Genre Search Outside'])
    const inside = body(await scoped('genre search'), SearchResults)
    expect(titles(inside.albums)).toEqual(['Genre Search Inside'])
    expect(titles(inside.tracks)).toEqual(['Genre Search Song'])
    expect(body(await scoped('genre act'), SearchResults).artists.map((artist) => artist.name)).toEqual(['Genre Act One'])
  })

  it('finds what the user hearted though it has no file yet, for that user only', async () => {
    const saved = await createAlbum({ title: 'Saved Before Arrival', artist: await createArtist({ name: 'Hearted Band' }), tracks: [{ title: 'On Its Way' }] })
    const followed = await createArtist({ name: 'Followed Only' })
    expect(await search('saved before')).toMatchObject({ albums: [], tracks: [] })
    await db.insert(likes).values([
      { userId: user.id, entityType: 'album', entityId: saved.albumId },
      { userId: user.id, entityType: 'recording', entityId: saved.tracks[0]!.recordingId },
      { userId: user.id, entityType: 'artist', entityId: followed.id },
    ])
    expect(titles((await search('saved before')).albums)).toEqual(['Saved Before Arrival'])
    expect(titles((await search('on its way')).tracks)).toEqual(['On Its Way'])
    expect((await search('followed only')).artists.map((artist) => artist.name)).toEqual(['Followed Only'])
    expect(await search('saved before', other)).toMatchObject({ albums: [], tracks: [] })
    expect((await search('followed only', other)).artists).toEqual([])
    await db.delete(likes)
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
    // Two letters swapped count as one typo; two typos are too far.
    expect(await top('paranoid andriod')).toEqual(['track', 'Paranoid Android'])
    expect(await top('paranoid andrxyd')).toBeNull()
    // Scored on the same scale as the catalog's top result, so a client can pick between them.
    expect(await scored('radiohead')).toBe(3)
    expect(await scored('radiohead ok computer')).toBe(3)
    expect(await scored('para')).toBe(1)
    expect(await scored('radiohed')).toBe(1)
  })

  it('ranks every result on one list, and pages one kind', async () => {
    const all = await search('radiohead')
    expect(all.ranked?.[0]).toMatchObject({ type: 'artist', id: all.artists[0]!.id })
    expect(all.top).toEqual({ type: 'artist', id: all.artists[0]!.id, score: 3 })
    const listed = [...all.artists, ...all.albums, ...all.tracks].map((item) => item.id)
    expect(all.ranked!.map((item) => item.id).sort()).toEqual(listed.sort())
    expect(all.ranked!.every((item) => item.score > 0 && item.score <= 1)).toBe(true)

    const page = async (offset: number) =>
      body(await app.inject({ url: `/api/v1/search/library?q=radiohead&type=track&limit=3&offset=${offset}`, headers: user.headers }), SearchResults)
    const pages = await Promise.all([page(0), page(3), page(6)])
    expect(pages.every((one) => one.artists.length === 0 && one.albums.length === 0)).toBe(true)
    expect(pages.map((one) => one.tracks.length)).toEqual([3, 3, 1])
    expect(pages.flatMap((one) => one.tracks.map((track) => track.id))).toEqual(all.tracks.map((track) => track.id))
  })

  it('says which albums and artists the viewer saved, for their menus', async () => {
    const before = await search('radiohead')
    const kidA = before.albums.find((album) => album.title === 'Kid A')!
    const radiohead = before.artists.find((artist) => artist.name === 'Radiohead')!
    expect([kidA.liked, radiohead.liked]).toEqual([false, false])
    await db.insert(likes).values([
      { userId: user.id, entityType: 'album', entityId: kidA.id },
      { userId: user.id, entityType: 'artist', entityId: radiohead.id },
    ])
    const after = await search('radiohead')
    expect(after.albums.map((album) => [album.title, album.liked]).sort()).toEqual([['Kid A', true], ['OK Computer', false]])
    expect(after.artists.find((artist) => artist.id === radiohead.id)?.liked).toBe(true)
    // Another user's saves are their own.
    expect((await search('radiohead', other)).albums.every((album) => album.liked === false)).toBe(true)
    await db.delete(likes).where(and(eq(likes.userId, user.id), inArray(likes.entityId, [kidA.id, radiohead.id])))
  })

  it('works from the second character', async () => {
    expect(titles((await search('ok')).albums)).toEqual(['OK Computer'])
    expect(await search('o')).toEqual({ artists: [], albums: [], tracks: [], provider: null, top: null, ranked: [] })
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

  it.each([
    ['宇多田ヒカル', '宇多田ひかる'],
    ['宇多田ヒカル', '宇多田ヒカフ'],
    ['Кино', 'Кно'],
    ['Μίκης Θεοδωράκης', 'Μίκης Θεοδωράκς'],
    ['فيروز', 'فيرز'],
    ['방탄소년단', '방탄소녀단'],
  ])('fuzzily matches %s from %s without a locale-dependent trigram', async (name, query) => {
    const artist = await createArtist({ name })
    await createAlbum({ title: name, artist, owned: true, tracks: [{ title: name }] })
    const found = await search(query)
    expect(found.artists.map((item) => item.name)).toContain(name)
    expect(titles(found.albums)).toContain(name)
    expect(titles(found.tracks)).toContain(name)
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

  it('finds featured artists in global search and uses album credits for Library membership', async () => {
    const guest = await createArtist({ name: 'Pharrell Williams' })
    const [getLucky] = await db.select().from(recordings).where(eq(recordings.title, 'Get Lucky'))
    await db.insert(recordingArtists).values({ recordingId: getLucky!.id, position: 1, artistId: guest.id, creditedName: guest.name })
    expect((await search('pharrell')).artists).toEqual([])
    const global = await app.inject({ url: '/api/v1/search/library?q=pharrell&scope=server', headers: user.headers })
    expect(body(global, SearchResults).artists.map((artist) => artist.name)).toEqual(['Pharrell Williams'])
  })
})
