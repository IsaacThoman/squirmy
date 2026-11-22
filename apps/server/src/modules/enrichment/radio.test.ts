import { eq, sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { artists, externalIds, recordings } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { artistRadioTracks } from './detail.js'

describe("an artist's Deezer radio", () => {
  useTestDatabase()
  const http = useHttpFixtures('deezer')

  beforeAll(async () => {
    await updateServerSettings({ deezerEnabled: true })
  })

  it('becomes catalog rows: the ones the catalog has, else stubs with their own artists', async () => {
    const khruangbin = await createArtist({ name: 'Khruangbin' })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: '5328540', entityId: khruangbin.id })
    // A track the server already knows by its artist and title.
    const known = await createAlbum({ artist: khruangbin, title: 'Con Todo El Mundo', tracks: [{ title: 'C-Side' }] })

    const ids = await artistRadioTracks(khruangbin.id)
    expect(ids).toHaveLength(25)
    expect(ids[0]).toBe(known.tracks[0]!.recordingId)
    const rows = await db.execute<{ artist: string }>(sql`
      select a.name as artist from recordings r join artists a on a.id = r.primary_artist_id
      where r.id = any(${`{${ids.join(',')}}`}::uuid[])`)
    const names = new Set(rows.map((row) => row.artist))
    // Artists like Khruangbin that the catalog did not know, each with its Deezer id.
    for (const name of ['Sault', 'Skinshape', 'Tom Misch', 'Michael Kiwanuka']) expect(names.has(name)).toBe(true)
    const [sault] = await db.select({ id: artists.id }).from(artists).where(eq(artists.name, 'Sault'))
    const [linked] = await db.select().from(externalIds).where(eq(externalIds.entityId, sault!.id))
    expect(linked).toMatchObject({ provider: 'deezer', entityType: 'artist' })

    // Asking again reads nothing and writes nothing.
    const requests = http.requests.length
    const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(recordings))[0]!.n
    const before = await count()
    expect(await artistRadioTracks(khruangbin.id)).toEqual(ids)
    expect(http.requests).toHaveLength(requests)
    expect(await count()).toBe(before)
  })

  it('answers by the wait with the rows written so far, and has the rest next time', async () => {
    const cocteau = await createArtist({ name: 'Cocteau Twins' })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: '1041', entityId: cocteau.id })
    const early = await artistRadioTracks(cocteau.id, { waitMs: 0 })
    expect(early.length).toBeLessThan(25)
    // The run carried on; the next caller joins it, or reuses what it wrote.
    const all = await artistRadioTracks(cocteau.id)
    expect(all.length).toBeGreaterThanOrEqual(24)
    expect(all.slice(0, early.length)).toEqual(early)
  })

  it('is empty, and asks nothing, while Deezer is off', async () => {
    await updateServerSettings({ deezerEnabled: false })
    const requests = http.requests.length
    const artist = await createArtist({ name: 'Portishead' })
    expect(await artistRadioTracks(artist.id)).toEqual([])
    expect(http.requests).toHaveLength(requests)
    await updateServerSettings({ deezerEnabled: true })
  })
})
