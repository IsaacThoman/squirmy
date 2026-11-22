import { readFile } from 'node:fs/promises'
import { eq, inArray, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { newId, newPublicId } from '../lib/ids.js'
import { creditKey, matchKey } from '../lib/text.js'
import { useTestDatabase } from '../test/database.js'
import { createAlbum, createArtist, createUser } from '../test/factories.js'
import { db } from './client.js'
import { albumArtists, albums, assets, externalIds, likes } from './schema.js'

/**
 * Migration 0014 on an install with history: the test database is already migrated, so the
 * statements are replayed from the migration file against rows written the old way.
 */
describe('migration 0014_cover_repairs', () => {
  useTestDatabase()

  async function replay() {
    const file = await readFile(new URL('../../drizzle/0014_cover_repairs.sql', import.meta.url), 'utf8')
    const statements = file.split('--> statement-breakpoint')
    expect(statements).toHaveLength(4)
    // 0014 checks saves in library_items, which 0018 folded into likes and dropped.
    await db.execute(sql`create table if not exists library_items (user_id uuid, entity_type text, entity_id uuid)`)
    for (const statement of statements) await db.execute(sql.raw(statement))
  }

  const caa = (mbid: string) => `https://coverartarchive.org/release-group/${mbid}/front-500`

  /** A discography row as artist detail wrote it: level 1, no track list, a lazy group cover. */
  async function discographyRow(artist: { id: string; name: string }, title: string) {
    const id = newId()
    const mbid = crypto.randomUUID()
    const [cover] = await db.insert(assets).values({ id: newPublicId(), kind: 'cover', source: caa(mbid), remoteUrl: caa(mbid), status: 'remote' }).returning()
    await db.insert(albums).values({
      id, mbid, title, artistCredit: artist.name, primaryArtistId: artist.id, type: 'compilation', detailLevel: 1,
      titleKey: matchKey(title), matchKey: creditKey(artist.name, title), artworkAssetId: cover!.id,
    })
    await db.insert(albumArtists).values({ albumId: id, position: 0, artistId: artist.id, creditedName: artist.name })
    return { id, mbid, coverId: cover!.id }
  }

  const present = async (table: typeof albums | typeof assets, ids: string[]) =>
    (await db.select({ id: table.id }).from(table).where(inArray(table.id, ids))).map((row) => row.id).sort()

  it('removes the compilations Various Artists\' discography brought in that nothing uses, and their covers', async () => {
    const various = await createArtist({ name: 'Various Artists', mbid: '89ad4ac3-39f7-470e-963a-56509c546377' })
    const band = await createArtist({ name: 'A Band', mbid: crypto.randomUUID() })
    const unused = await discographyRow(various, 'Hits of the Year')
    const liked = await discographyRow(various, 'Liked Hits')
    await db.insert(likes).values({ userId: (await createUser()).id, entityType: 'album', entityId: liked.id })
    const linked = await discographyRow(various, 'Linked Hits')
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: '123', entityId: linked.id })
    const target = await discographyRow(various, 'Adopted Hits')
    const stub = await createAlbum({ title: 'Adopted Hits', artist: various })
    await db.update(albums).set({ mergedIntoId: target.id }).where(eq(albums.id, stub.albumId))
    const owned = await createAlbum({ title: 'Owned Hits', artist: various, mbid: crypto.randomUUID(), owned: true })
    const opened = await discographyRow(various, 'Opened Hits')
    await db.update(albums).set({ detailLevel: 2 }).where(eq(albums.id, opened.id))
    const bands = await discographyRow(band, 'Second Album')

    await replay()

    const kept = [liked, linked, target, opened, bands]
    expect(await present(albums, [unused.id, ...kept.map((row) => row.id), owned.albumId])).toEqual([...kept.map((row) => row.id), owned.albumId].sort())
    expect(await present(assets, [unused.coverId, ...kept.map((row) => row.coverId)])).toEqual(kept.map((row) => row.coverId).sort())
  })

  it('offers the archive\'s covers that failed again, and gives them back to albums that lost them', async () => {
    const band = await createArtist({ name: 'Fresh Band', mbid: crypto.randomUUID() })
    const fresh = await discographyRow(band, 'Out Last Week')
    // The art route unassigned it when archive.org had not derived the 500 px front yet.
    await db.update(assets).set({ status: 'failed', checkedAt: new Date() }).where(eq(assets.id, fresh.coverId))
    await db.update(albums).set({ artworkAssetId: null }).where(eq(albums.id, fresh.id))
    const flaky = await discographyRow(band, 'Still Assigned')
    await db.update(assets).set({ status: 'failed', checkedAt: new Date() }).where(eq(assets.id, flaky.coverId))
    const [deezer] = await db.insert(assets).values({
      id: newPublicId(), kind: 'cover', source: 'https://cdn-images.dzcdn.net/images/cover/x/500x500.jpg',
      remoteUrl: 'https://cdn-images.dzcdn.net/images/cover/x/500x500.jpg', status: 'failed', checkedAt: new Date(),
    }).returning()

    await replay()

    const status = async (id: string) => (await db.select({ status: assets.status, checkedAt: assets.checkedAt }).from(assets).where(eq(assets.id, id)))[0]
    expect(await status(fresh.coverId)).toEqual({ status: 'remote', checkedAt: null })
    expect(await status(flaky.coverId)).toEqual({ status: 'remote', checkedAt: null })
    expect((await status(deezer!.id))!.status).toBe('failed')
    expect((await db.select({ id: albums.artworkAssetId }).from(albums).where(eq(albums.id, fresh.id)))[0]!.id).toBe(fresh.coverId)
  })
})
