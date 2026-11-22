import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { artists } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { useTestDatabase } from '../../test/database.js'
import { createArtist } from '../../test/factories.js'
import { resolveMerged, resolveOne } from './redirects.js'

describe('merge redirects', () => {
  useTestDatabase()

  const mergeInto = (from: string, into: string) => db.update(artists).set({ mergedIntoId: into }).where(eq(artists.id, from))

  it('follows chains, keeps unmerged ids, drops unknown ids and broken chains', async () => {
    const [a, b, c, plain, loopA, loopB, dangling] = await Promise.all(Array.from({ length: 7 }, () => createArtist()))
    await mergeInto(a!.id, b!.id)
    await mergeInto(b!.id, c!.id)
    await mergeInto(loopA!.id, loopB!.id)
    await mergeInto(loopB!.id, loopA!.id)
    await mergeInto(dangling!.id, newId())
    const unknown = newId()

    const resolved = await resolveMerged('artists', [a!.id, b!.id, c!.id, plain!.id, plain!.id, unknown, loopA!.id, dangling!.id])
    expect(Object.fromEntries(resolved)).toEqual({ [a!.id]: c!.id, [b!.id]: c!.id, [c!.id]: c!.id, [plain!.id]: plain!.id })
    expect(await resolveOne('artists', a!.id)).toBe(c!.id)
    expect(await resolveOne('artists', unknown)).toBeNull()
  })

  it('follows sixteen hops and no more', async () => {
    const chain = await Promise.all(Array.from({ length: 18 }, () => createArtist()))
    for (let index = 0; index < chain.length - 1; index++) await mergeInto(chain[index]!.id, chain[index + 1]!.id)
    const last = chain.at(-1)!.id
    const resolved = await resolveMerged('artists', chain.map((artist) => artist.id))
    // The first row is 17 hops from the end, the second 16.
    expect(resolved.has(chain[0]!.id)).toBe(false)
    expect(resolved.get(chain[1]!.id)).toBe(last)
    expect(resolved.get(last)).toBe(last)
  })
})
