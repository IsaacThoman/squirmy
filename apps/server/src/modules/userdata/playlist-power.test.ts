import {
  LibraryItemPage, Ok, PlaylistCollaborator, PlaylistDedupeResult, PlaylistDetail, PlaylistFolder, PlaylistImportResult,
  PlaylistPage, PlaylistPerson, PlaylistSummary, queryKeys, SearchResults,
} from '@squirmy/contracts'
import { asc, eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, playlistItems } from '../../database/schema.js'
import { invalidate, publishChanges } from '../../realtime/index.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createAsset, createFile } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createLibraryRoot } from '../../test/factories.js'
import { subsonicClient } from '../../test/subsonic-client.js'
import { createAppPassword } from '../auth/service.js'
import { coverArtId, playlistId, trackId } from '../subsonic/ids.js'
import { replacePlaylistItems } from './playlists.js'

vi.mock('../../realtime/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../realtime/index.js')>(),
  invalidate: vi.fn(async () => {}),
  publishChanges: vi.fn(async () => {}),
}))

describe('playlist power features', () => {
  useTestDatabase()
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signIn>>
  let guest: typeof owner
  let outsider: typeof owner
  const call = (who: typeof owner, url: string, options: Omit<InjectOptions, 'url'> = {}) =>
    app.inject({ ...options, url: `/api/v1${url}`, headers: { ...who.headers, ...options.headers } })
  const create = async (name: string) => body(await call(owner, '/playlists', { method: 'POST', payload: { name } }), PlaylistSummary, 201)
  const detail = async (who: typeof owner, id: string) => body(await call(who, `/playlists/${id}`), PlaylistDetail)
  const add = (who: typeof owner, id: string, ...ids: string[]) =>
    call(who, `/playlists/${id}/items`, { method: 'POST', payload: { tracks: ids.map(trackId => ({ trackId })) } })
  const membership = (id: string, role: 'add' | 'edit') =>
    call(owner, `/playlists/${id}/collaborators/${guest.id}`, { method: 'PUT', payload: { role } })
  const upload = (who: typeof owner, url: string, file: string, contents: string | Uint8Array) => {
    const boundary = 'playlist-test-boundary'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      Buffer.from(contents), Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    return call(who, url, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
  }

  beforeAll(async () => {
    app = await buildApp()
    owner = await signIn({ username: 'mira' })
    guest = await signIn({ username: 'lune' })
    outsider = await signIn({ username: 'kai' })
  })
  afterAll(async () => app.close())

  it('grants private playlist access and invalidates both members when add-only changes', async () => {
    const { id } = await create('Private rehearsals')
    const { tracks: [song] } = await createAlbum({ owned: true })
    expect(errorCode(await call(guest, `/playlists/${id}`), 404)).toBe('playlist_not_found')
    expect(body(await call(owner, `/playlists/${id}/people?q=lun`), PlaylistPerson.array())).toEqual([{ id: guest.id, username: 'lune', name: 'lune' }])
    body(await membership(id, 'add'), Ok)
    expect(body(await call(owner, `/playlists/${id}/collaborators`), PlaylistCollaborator.array())).toEqual([
      { id: guest.id, username: 'lune', name: 'lune', role: 'add' },
    ])
    expect(errorCode(await call(guest, `/playlists/${id}/people`), 403)).toBe('forbidden')
    expect(body(await call(guest, '/playlists'), PlaylistPage).items).toContainEqual(expect.objectContaining({ id, collaboratorRole: 'add' }))
    expect(body(await call(guest, '/library/items'), LibraryItemPage).items).toContainEqual(expect.objectContaining({ kind: 'playlist', playlist: expect.objectContaining({ id }) }))
    const search = body(await call(guest, '/search/library?scope=server&type=playlist&q=private%20rehearsals'), SearchResults)
    expect(search.playlists?.map(playlist => playlist.id)).toContain(id)
    expect(errorCode(await call(outsider, `/playlists/${id}/export?format=json`), 404)).toBe('playlist_not_found')

    vi.mocked(invalidate).mockClear()
    const added = body(await add(guest, id, song!.recordingId), PlaylistDetail)
    expect(added.collaborative).toBe(true)
    expect(added.items[0]?.addedByName).toBe('lune')
    expect(invalidate).toHaveBeenCalledWith([{ user: owner.id }, { user: guest.id }],
      [queryKeys.playlists(), queryKeys.libraryItems(), queryKeys.home(), queryKeys.search()])
    const item = added.items[0]!
    expect(errorCode(await call(guest, `/playlists/${id}/items/${item.itemId}`, { method: 'DELETE' }), 403)).toBe('forbidden')
    expect(errorCode(await call(guest, `/playlists/${id}/items/move`, { method: 'POST', payload: { itemId: item.itemId, toIndex: 0 } }), 403)).toBe('forbidden')
    expect(errorCode(await call(guest, `/playlists/${id}`, { method: 'PATCH', payload: { name: 'Changed' } }), 403)).toBe('forbidden')
    body(await membership(id, 'edit'), Ok)
    body(await call(guest, `/playlists/${id}/items/${item.itemId}`, { method: 'DELETE' }), PlaylistDetail)
    body(await call(owner, `/playlists/${id}/collaborators/${guest.id}`, { method: 'DELETE' }), Ok)
    expect(publishChanges).toHaveBeenCalledWith({ user: guest.id }, [{ kind: 'deleted', entity: 'playlist', ids: [id] }])
    expect(errorCode(await call(guest, `/playlists/${id}`), 404)).toBe('playlist_not_found')
  })

  it('serializes appends and resolves a move by item after another editor changes the order', async () => {
    const { id } = await create('Two editors')
    body(await membership(id, 'edit'), Ok)
    const album = await createAlbum()
    const [first, second, third] = album.tracks.map(track => track.recordingId)
    await Promise.all([add(owner, id, first!), add(guest, id, second!), add(guest, id, third!)]).then(answers =>
      answers.forEach(answer => expect(answer.statusCode).toBe(200)))
    const initial = (await detail(owner, id)).items
    expect(initial).toHaveLength(3)
    const [a, b, c] = initial.map(item => item.itemId)
    body(await call(owner, `/playlists/${id}/items/${a}`, { method: 'DELETE' }), PlaylistDetail)
    const moved = body(await call(guest, `/playlists/${id}/items/move`, { method: 'POST', payload: {
      itemId: c, toIndex: 1, anchor: { itemId: b, side: 'before' },
    } }), PlaylistDetail)
    expect(moved.items.map(item => item.itemId)).toEqual([c, b])
    await expect(replacePlaylistItems(owner.id, id, [{ itemId: b! }], [a!, b!, c!])).rejects.toMatchObject({ code: 'playlist_changed' })
    expect((await detail(owner, id)).items.map(item => item.itemId)).toEqual([c, b])
    expect((await db.select().from(playlistItems).where(eq(playlistItems.playlistId, id)).orderBy(asc(playlistItems.position)))
      .map(item => item.position)).toEqual([0, 1])
  })

  it('keeps folders private and moves their playlists back to the root on deletion', async () => {
    const { id } = await create('Filed songs')
    const folder = body(await call(owner, '/playlists/folders', { method: 'POST', payload: { name: 'Work' } }), PlaylistFolder, 201)
    const other = await call(guest, '/playlists/folders', { method: 'POST', payload: { name: 'Personal' } })
    expect(errorCode(await call(owner, `/playlists/${id}`, { method: 'PATCH', payload: { folderId: PlaylistFolder.parse(other.json()).id } }), 404))
      .toBe('playlist_folder_not_found')
    const filed = body(await call(owner, `/playlists/${id}`, { method: 'PATCH', payload: { folderId: folder.id } }), PlaylistSummary)
    expect(filed.folderId).toBe(folder.id)
    body(await membership(id, 'edit'), Ok)
    expect((await detail(guest, id)).folderId).toBeNull()
    expect(body(await call(guest, '/playlists/folders'), PlaylistFolder.array()).map(folder => folder.name)).toEqual(['Personal'])
    body(await call(owner, `/playlists/folders/${folder.id}`, { method: 'DELETE' }), Ok)
    expect((await detail(owner, id)).folderId).toBeNull()
  })

  it('uses a custom cover across clients and restores the album collage', async () => {
    const { id } = await create('Covered songs')
    const album = await createAlbum({ owned: true })
    const artwork = await createAsset()
    await db.update(albums).set({ artworkAssetId: artwork.id }).where(eq(albums.id, album.albumId))
    body(await add(owner, id, album.tracks[0]!.recordingId), PlaylistDetail)
    body(await membership(id, 'add'), Ok)
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#339bee' } }).png().toBuffer()
    expect(errorCode(await upload(guest, `/playlists/${id}/cover`, 'new.png', png), 403)).toBe('forbidden')
    expect(errorCode(await upload(owner, `/playlists/${id}/cover`, 'invalid.png', 'not an image'), 422)).toBe('invalid_image')
    const custom = body(await upload(owner, `/playlists/${id}/cover`, 'cover.png', png), PlaylistSummary)
    expect(custom.customCover).toBe(true)
    expect(custom.artworks).toHaveLength(1)
    expect(custom.artworks[0]?.id).not.toBe(artwork.id)
    const password = await createAppPassword(guest.id, 'test')
    const sub = subsonicClient(app, { username: 'lune', secret: password.secret! })
    const subPlaylist = playlistId(id)
    expect(await sub.json('getPlaylist', { id: subPlaylist })).toMatchObject({ playlist: { coverArt: coverArtId(custom.artworks[0]!.id), readonly: false } })
    expect((await sub.raw('getCoverArt', { id: subPlaylist, size: 64 })).headers['content-type']).toBe('image/jpeg')
    expect(await sub.json('updatePlaylist', { playlistId: subPlaylist, songIdToAdd: trackId(album.tracks[0]!.recordingId) })).toMatchObject({ status: 'ok' })
    expect(await sub.json('updatePlaylist', { playlistId: subPlaylist, songIndexToRemove: 0 })).toMatchObject({ error: { code: 50 } })
    body(await membership(id, 'edit'), Ok)
    expect(await sub.json('updatePlaylist', { playlistId: subPlaylist, songIndexToRemove: 0 })).toMatchObject({ status: 'ok' })
    const automatic = body(await call(owner, `/playlists/${id}/cover`, { method: 'DELETE' }), PlaylistSummary)
    expect(automatic).toMatchObject({ customCover: false, artworks: [expect.objectContaining({ id: artwork.id })] })
  })

  it('imports UTF-8 track lists, M3U, XSPF and Exportify CSV against the catalog', async () => {
    const album = await createAlbum({ artist: await createArtist({ name: 'Beyoncé & Mira' }), title: 'Voices', tracks: [{ title: 'Lines, in Blue' }] })
    const song = album.tracks[0]!.recordingId
    const root = await createLibraryRoot()
    const relative = 'Voices/01 Lines, in Blue.flac'
    await createFile({ rootId: root.id, recordingId: song, albumId: album.albumId, relPath: relative })
    const cases = [
      ['Text.txt', 'Beyonce and Mira - Lines, in Blue\nMissing - Song\n'],
      ['Mix.m3u', `#EXTM3U\n${root.path}/${relative}\nmissing.flac\n`],
      ['Mix.m3u8', `#EXTM3U\n./${relative}\nmissing.flac\n`],
      ['Mix.xspf', `<p:playlist xmlns:p="http://xspf.org/ns/0/"><p:trackList>
        <p:track><p:location>Voices/01%20Lines%2C%20in%20Blue.flac</p:location></p:track>
        <p:track><p:location>https://example.invalid/missing</p:location></p:track>
      </p:trackList></p:playlist>`],
      ['Spotify.csv', '"Track Name","Artist Name(s)","Album Name"\r\n"Lines, in Blue","Beyoncé & Mira","Voices"\r\n"No song","Missing",""\r\n'],
    ] as const
    for (const [file, content] of cases) {
      const result = body(await upload(owner, '/playlists/import', file, content), PlaylistImportResult, 201)
      expect(result.matched, file).toBe(1)
      expect(result.unmatched, file).toEqual([expect.objectContaining({ line: expect.any(Number), text: expect.any(String) })])
      expect((await detail(owner, result.playlist.id)).items.map(item => item.track.id)).toEqual([song])
    }
    const dtd = '<!DOCTYPE playlist [<!ENTITY ext SYSTEM "file:///etc/passwd">]><playlist>&ext;</playlist>'
    expect(errorCode(await upload(owner, '/playlists/import', 'invalid.xspf', dtd), 400)).toBe('invalid_playlist_file')
  })

  it('exports files in playlist order using root-relative paths and round-trips missing song metadata', async () => {
    const { id } = await create('Night & day')
    const album = await createAlbum({ artist: await createArtist({ name: 'Mira & Lune' }), title: 'Night', tracks: [{ title: 'Tiny <Moon>' }, { title: 'Stars' }] })
    const [owned, gray] = album.tracks.map(track => track.recordingId)
    const root = await createLibraryRoot()
    await createFile({ rootId: root.id, recordingId: owned!, albumId: album.albumId, relPath: 'Night/Tiny Moon.flac' })
    body(await add(owner, id, gray!, owned!), PlaylistDetail)
    const output = (format: string) => call(owner, `/playlists/${id}/export?format=${format}`)
    const m3u = await output('m3u8')
    expect(m3u.statusCode).toBe(200)
    expect(m3u.body).toContain('#EXTINF:')
    expect(m3u.body.indexOf('Stars')).toBeLessThan(m3u.body.indexOf('./Night/Tiny Moon.flac'))
    expect(m3u.body).not.toContain(root.path)
    const xspf = await output('xspf')
    expect(xspf.body).toContain('Tiny &lt;Moon&gt;')
    expect(xspf.body).toContain('./Night/Tiny%20Moon.flac')
    const json = await output('json')
    expect(json.json()).toMatchObject({ name: 'Night & day', tracks: [{ id: gray, path: null }, { id: owned, path: 'Night/Tiny Moon.flac' }] })
    for (const [file, content] of [['Export.m3u8', m3u.body], ['Export.xspf', xspf.body]] as const) {
      const result = body(await upload(owner, '/playlists/import', file, content), PlaylistImportResult, 201)
      expect(result.unmatched).toEqual([])
      expect((await detail(owner, result.playlist.id)).items.map(item => item.track.id)).toEqual([gray, owned])
    }
  })

  it('keeps the first item and its attribution when removing duplicates across editions', async () => {
    const { id } = await create('Repeated songs')
    const album = await createAlbum({ artist: await createArtist({ name: 'Echo' }), tracks: [{ title: 'One' }, { title: 'One (Remastered)' }, { title: 'One (Live)' }] })
    const [one, remaster, live] = album.tracks.map(track => track.recordingId)
    body(await membership(id, 'edit'), Ok)
    const before = body(await add(guest, id, one!, live!, remaster!, one!), PlaylistDetail)
    const dedupe = async (editions: boolean) => body(await call(guest, `/playlists/${id}/items/dedupe`, {
      method: 'POST', payload: { editions },
    }), PlaylistDedupeResult)
    expect((await dedupe(false)).removed).toBe(1)
    const after = await dedupe(true)
    expect(after.removed).toBe(1)
    expect(after.playlist.items.map(item => item.itemId)).toEqual(before.items.slice(0, 2).map(item => item.itemId))
    expect(after.playlist.items[0]?.addedByName).toBe('lune')
  })
})
