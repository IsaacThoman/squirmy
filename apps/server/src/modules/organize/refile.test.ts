import { access } from 'node:fs/promises'
import path from 'node:path'
import { eq, inArray, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { mediaFiles, organizeBatches } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { createArtist } from '../../test/factories.js'
import { addAlbum, makeRoot, manifest, relPathOf, writeFixture } from '../../test/organize-library.js'
import { refileCredits } from './refile.js'

describe('organize: re-filing deliveries whose credits were corrected', () => {
  useTestDatabase()

  const batches = async () => (await db.select({ count: sql<number>`count(*)::int` }).from(organizeBatches))[0]!.count

  it('moves a delivery to the folder its credits name now, removes the folders it leaves, and moves nothing else', async () => {
    const root = await makeRoot()
    // 2026-11-22: "ACCELERANDO" was filed under the artists its tags ran together, before
    // placement put it on the album MusicBrainz credits to "Grimes & VADAKIN".
    const accelerando = await addAlbum(root, { artist: await createArtist({ name: 'Grimes & VADAKIN' }), title: 'ACCELERANDO', year: 2026, tracks: [{ title: 'ACCELERANDO' }] },
      ['_Fetched/Grimes, VADAKIN/ACCELERANDO (2026)/01 ACCELERANDO.m4a'])
    await writeFixture(root.path, '_Fetched/Grimes, VADAKIN/ACCELERANDO (2026)/cover.jpg')
    // Filed before its year was known and on another track number: the credit is right, so it stays.
    const baggy = await addAlbum(root, { artist: await createArtist({ name: 'Fcukers' }), title: 'Baggy$$', year: 2024, tracks: [{ title: 'UMPA' }] },
      ['_Fetched/Fcukers/Baggy$$/04 UMPA.m4a'])
    // Music someone brought is theirs to organize, whatever its folder says.
    const brought = await addAlbum(root, { artist: await createArtist({ name: 'Tiga feat. Fcukers' }), title: 'SILK SCARF', year: 2026, tracks: [{ title: 'SILK SCARF' }] },
      ['Tiga, Fcukers/SILK SCARF (2026)/01 SILK SCARF.m4a'])
    await db.update(mediaFiles).set({ source: 'provider:test' }).where(inArray(mediaFiles.id, [...accelerando.fileIds, ...baggy.fileIds]))
    const before = await batches()

    expect(await refileCredits(root.id)).toBe(1)
    const moved = '_Fetched/Grimes & VADAKIN/ACCELERANDO (2026)/01 ACCELERANDO.m4a'
    expect(await relPathOf(accelerando.fileIds[0]!)).toBe(moved)
    await access(path.join(root.path, moved))
    expect(await relPathOf(baggy.fileIds[0]!)).toBe('_Fetched/Fcukers/Baggy$$/04 UMPA.m4a')
    expect(await relPathOf(brought.fileIds[0]!)).toBe('Tiga, Fcukers/SILK SCARF (2026)/01 SILK SCARF.m4a')
    expect(Object.keys(await manifest(root.path)).filter((entry) => entry.startsWith('_Fetched/')).sort()).toEqual([
      '_Fetched/', '_Fetched/Fcukers/', '_Fetched/Fcukers/Baggy$$/', '_Fetched/Fcukers/Baggy$$/04 UMPA.m4a',
      '_Fetched/Grimes & VADAKIN/', '_Fetched/Grimes & VADAKIN/ACCELERANDO (2026)/', moved, '_Fetched/Grimes & VADAKIN/ACCELERANDO (2026)/cover.jpg',
    ])
    // The move is in the root's history, like any batch.
    expect(await batches()).toBe(before + 1)

    // Nothing left to move: no batch is kept for it.
    expect(await refileCredits(root.id)).toBe(0)
    expect(await batches()).toBe(before + 1)
    expect((await db.select({ relPath: mediaFiles.relPath }).from(mediaFiles).where(eq(mediaFiles.id, accelerando.fileIds[0]!)))[0]!.relPath).toBe(moved)
  })
})
