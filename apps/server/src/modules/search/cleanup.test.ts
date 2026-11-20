import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, assets, externalIds, likes, playbackSessions, playlistItems, playlists, releases, wants } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { createFile, createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createLibraryRoot, createUser } from '../../test/factories.js'
import { cleanupStubs, stubMaxAgeDays } from './cleanup.js'
import { materialize } from './materialize.js'
import type { ProviderAlbum, ProviderTrack } from './providers.js'

const credit = (name: string) => [{ id: `artist-${name}`, mbid: null, name, joinPhrase: '' }]
const album = (name: string, artist = 'Gone Artist'): ProviderAlbum => ({
  id: `album-${name}`, mbid: null, title: name, artistCredit: artist, artists: credit(artist), type: 'album', year: null, releaseDate: null,
  artworkUrl: `https://images.example.test/${name}.jpg`,
})
const track = (name: string, extra: Partial<ProviderTrack> = {}): ProviderTrack => ({
  id: `track-${name}`, mbid: null, title: name, artistCredit: 'Gone Artist', artists: credit('Gone Artist'), durationMs: 100_000,
  explicit: null, popularity: null, isrcs: [], album: null, ...extra,
})

describe('search.cleanup', () => {
  useTestDatabase()
  const ids = new Map<string, string>()
  const exists = async (table: 'albums' | 'recordings' | 'artists', name: string) =>
    (await db.execute(sql`select 1 from ${sql.identifier(table)} where id = ${ids.get(name)!}`)).length === 1

  beforeAll(async () => {
    const user = await createUser()
    const albumNames = ['unkept', 'hinted', 'liked', 'enriched', 'basic', 'played', 'merged']
    const trackNames = ['unkept', 'liked', 'listed', 'played', 'wanted', 'queued', 'filed', 'fresh', 'merged']
    const stored = await materialize('deezer', {
      artists: [{ id: 'artist-Liked Artist', mbid: null, name: 'Liked Artist', imageUrl: 'https://images.example.test/liked.jpg' }],
      albums: albumNames.map((name) => album(name)),
      tracks: trackNames.map((name) => track(name, name === 'liked' ? { artists: credit('Kept Artist'), artistCredit: 'Kept Artist', album: album('hinted') } : {})),
    })
    albumNames.forEach((name, index) => ids.set(`album:${name}`, stored.albums[index]!))
    trackNames.forEach((name, index) => ids.set(`track:${name}`, stored.tracks[index]!))
    ids.set('artist:liked', stored.artists[0]!)
    const artistRows = await db.execute<{ id: string; name: string }>(sql`select id, name from artists`)
    for (const row of artistRows) ids.set(`artist:${row.name}`, row.id)

    await db.execute(sql`update artists set created_at = now() - interval '${sql.raw(String(stubMaxAgeDays + 1))} days'`)
    await db.execute(sql`update albums set created_at = now() - interval '${sql.raw(String(stubMaxAgeDays + 1))} days'`)
    await db.execute(sql`update recordings set created_at = now() - interval '${sql.raw(String(stubMaxAgeDays + 1))} days' where id <> ${ids.get('track:fresh')!}`)

    await db.insert(likes).values([
      { userId: user.id, entityType: 'recording', entityId: ids.get('track:liked')! },
      { userId: user.id, entityType: 'album', entityId: ids.get('album:liked')! },
      { userId: user.id, entityType: 'artist', entityId: ids.get('artist:liked')! },
    ])
    const [playlist] = await db.insert(playlists).values({ id: newId(), ownerId: user.id, name: 'Kept' }).returning()
    await db.insert(playlistItems).values({ id: newId(), playlistId: playlist!.id, position: 0, recordingId: ids.get('track:listed')! })
    await createPlay({ userId: user.id, recordingId: ids.get('track:played')!, albumId: ids.get('album:played')! })
    await db.insert(wants).values({ userId: user.id, entityType: 'recording', entityId: ids.get('track:wanted')! })
    await db.insert(playbackSessions).values({ userId: user.id, state: { queue: { entries: [{ trackId: ids.get('track:queued')!, albumId: null }] } } })
    await createFile({ rootId: (await createLibraryRoot()).id, recordingId: ids.get('track:filed')! })
    await db.insert(releases).values({ id: newId(), albumId: ids.get('album:enriched')!, mbid: newId(), title: 'enriched' })
    await db.update(albums).set({ detailLevel: 1 }).where(eq(albums.id, ids.get('album:basic')!))
    // A merge redirect keeps both rows.
    await db.execute(sql`update albums set merged_into_id = ${ids.get('album:merged')!} where id = ${ids.get('album:unkept')!}`)
    await db.execute(sql`update recordings set merged_into_id = ${ids.get('track:unkept')!} where id = ${ids.get('track:merged')!}`)
  })

  it('deletes only stubs nobody kept, with their external ids', async () => {
    const assetsBefore = (await db.select().from(assets)).length
    // Merge redirects first make the unkept rows targets; lift that to see them go.
    expect(await cleanupStubs()).toMatchObject({ recordings: 0 })
    expect(await exists('recordings', 'track:unkept')).toBe(true)
    await db.execute(sql`update albums set merged_into_id = null`)
    await db.execute(sql`update recordings set merged_into_id = null`)

    const deleted = await cleanupStubs()
    for (const name of ['liked', 'listed', 'played', 'wanted', 'queued', 'filed', 'fresh']) expect(await exists('recordings', `track:${name}`), name).toBe(true)
    for (const name of ['unkept', 'merged']) expect(await exists('recordings', `track:${name}`), name).toBe(false)
    for (const name of ['hinted', 'liked', 'enriched', 'basic', 'played']) expect(await exists('albums', `album:${name}`), name).toBe(true)
    for (const name of ['unkept', 'merged']) expect(await exists('albums', `album:${name}`), name).toBe(false)
    // Gone Artist is still credited on the kept recordings; Kept Artist on the liked one.
    expect(await exists('artists', 'artist:Gone Artist')).toBe(true)
    expect(await exists('artists', 'artist:Kept Artist')).toBe(true)
    expect(await exists('artists', 'artist:liked')).toBe(true)
    expect(deleted).toEqual({ recordings: 2, albums: 2, artists: 0 })

    const orphaned = await db.execute(sql`
      select 1 from external_ids e where not exists (
        select 1 from albums where id = e.entity_id union all select 1 from recordings where id = e.entity_id
        union all select 1 from artists where id = e.entity_id)`)
    expect(orphaned).toEqual([])
    expect(await db.select().from(externalIds).where(eq(externalIds.externalId, 'track-unkept'))).toEqual([])
    expect((await db.select().from(assets)).length).toBe(assetsBefore)
  })

  it('deletes artists once nothing credits them', async () => {
    await db.execute(sql`delete from likes where entity_type = 'artist'`)
    expect((await cleanupStubs()).artists).toBe(1)
    expect(await exists('artists', 'artist:liked')).toBe(false)
  })
})
