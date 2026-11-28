import { SearchResults } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { likes, lyrics, mediaFiles } from '../../database/schema.js'
import { body, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { createPlaylist, updatePlaylist } from '../userdata/playlists.js'

describe('universal search scopes', () => {
  useTestDatabase()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  let other: Awaited<ReturnType<typeof signIn>>

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    other = await signIn()
  })
  afterAll(async () => { await app.close() })

  const search = async (q: string, options: Record<string, string> = {}, as = user, route = 'library') =>
    body(await app.inject({
      url: `/api/v1/search/${route}?${new URLSearchParams({ q, scope: 'server', ...options })}`,
      headers: as.headers,
    }), SearchResults)

  it('pages the viewer’s and public playlists by name without leaking private playlists', async () => {
    const own = await createPlaylist(user.id, { name: 'Café Selections A', isPublic: false })
    const shared = await createPlaylist(other.id, { name: 'Café Selections B', isPublic: true })
    await createPlaylist(other.id, { name: 'Café Selections', isPublic: false })
    const one = await search('cafe selections', { type: 'playlist', limit: '1' })
    const two = await search('cafe selections', { type: 'playlist', limit: '1', offset: '1' })
    expect(one.playlists?.map(({ id }) => id)).toEqual([own.id])
    expect(two.playlists?.map(({ id }) => id)).toEqual([shared.id])
    expect(one.tracks).toEqual([])
    expect((await search('cafe selections')).playlists).toHaveLength(2)
    await updatePlaylist(other.id, shared.id, { isPublic: false })
    expect((await search('cafe selections')).playlists?.map(({ id }) => id)).toEqual([own.id])
  })

  it('searches stored lyrics, falls back to synced text and returns plain snippets', async () => {
    const owner = await createArtist({ name: 'Midnight Duo' })
    const owned = await createAlbum({ title: 'First Light', artist: owner, owned: true, tracks: [
      { title: 'Plain Song' }, { title: 'Synced Song' }, { title: 'Instrumental Song' },
    ] })
    const unavailable = await createAlbum({ title: 'Elsewhere', artist: owner, tracks: [{ title: 'Catalog Song' }] })
    await db.insert(lyrics).values([
      { recordingId: owned.tracks[0]!.recordingId, plain: 'I left a lantern near the old harbor in the rain', source: 'embedded' },
      { recordingId: owned.tracks[1]!.recordingId, synced: '[00:04.20]A lantern in the harbor\n[00:08.10]Shines across the bay', source: 'sidecar' },
      { recordingId: owned.tracks[2]!.recordingId, plain: 'A lantern in the harbor', instrumental: true, source: 'embedded' },
      { recordingId: unavailable.tracks[0]!.recordingId, plain: 'A lantern in the harbor', source: 'lrclib' },
    ])
    const answer = await search('lantern harbor', { type: 'lyrics' })
    expect(answer.tracks).toEqual([])
    expect(answer.lyrics?.map(({ track }) => track.title).sort()).toEqual(['Plain Song', 'Synced Song'])
    for (const { snippet, track } of answer.lyrics ?? []) {
      expect(snippet).toMatch(/lantern.*harbor/)
      expect(snippet).not.toMatch(/<b>|\[00:/)
      expect(track.availability).toBe('server')
    }
    expect((await search('lantern harbor', { type: 'lyrics', limit: '1', offset: '1' })).lyrics).toHaveLength(1)
    expect((await search('lantern harbor')).lyrics).toHaveLength(2)
  })

  it('combines source quality, album decade and the viewer’s likes before paging each kind', async () => {
    const artist = await createArtist({ name: 'Facet Band' })
    const make = (label: string, year: number) => createAlbum({
      title: `Facet ${label}`, year, artist, owned: true, tracks: [{ title: `Facet ${label}` }],
    })
    const [hi, cd, older] = await Promise.all([make('High', 1998), make('CD', 1999), make('Older', 1989)])
    for (const [album, bitDepth] of [[hi, 24], [cd, 16], [older, 24]] as const) {
      await db.update(mediaFiles).set({ lossless: true, bitDepth, sampleRate: 44100 }).where(eq(mediaFiles.id, album.tracks[0]!.fileId!))
    }
    await db.insert(likes).values([
      { userId: user.id, entityType: 'album', entityId: hi.albumId },
      { userId: user.id, entityType: 'recording', entityId: hi.tracks[0]!.recordingId },
      { userId: user.id, entityType: 'artist', entityId: artist.id },
    ])
    const filters = { quality: 'hi-res', decade: '1990', liked: 'true', limit: '1' }
    const combined = await search('facet', filters)
    expect(combined.artists.map(({ id }) => id)).toEqual([artist.id])
    expect(combined.albums.map(({ id }) => id)).toEqual([hi.albumId])
    expect(combined.tracks.map(({ id }) => id)).toEqual([hi.tracks[0]!.recordingId])
    expect((await search('facet', filters, other)).tracks).toEqual([])
    expect((await search('facet', { quality: 'lossless', decade: '1990' })).tracks).toHaveLength(2)
    expect((await search('facet', filters, user, 'catalog')).provider).toBeNull()
  })
})
