import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { externalIds } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { artistStub } from '../../test/enrichment-stubs.js'
import { createArtist } from '../../test/factories.js'
import { materialize } from './materialize.js'
import { withoutNamesakes } from './namesakes.js'

describe('one artist per name in a catalog answer', () => {
  useTestDatabase()

  it('leaves out Deezer duplicates of an artist the answer shows, as search stored them live', async () => {
    // The MusicBrainz row holds Deezer's main page; the duplicate page becomes a stub of its own.
    const boards = await createArtist({ name: 'Boards of Canada', mbid: '69158f97-4c07-4c4e-baf8-4e4ab1ed666e' })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: '1098', entityId: boards.id })
    const ids = await materialize('deezer', {
      artists: [
        { id: '1098', mbid: null, name: 'Boards of Canada', imageUrl: null },
        { id: '412310471', mbid: null, name: 'Boards of Canada', imageUrl: null },
        { id: '5', mbid: null, name: 'Boards of Canadas', imageUrl: null },
      ],
      albums: [],
      tracks: [],
    })
    expect(ids.artists).toHaveLength(3)
    expect(ids.artists[0]).toBe(boards.id)
    expect(await withoutNamesakes(ids.artists, [])).toEqual([boards.id, ids.artists[2]])
    // Shown by the library answer instead, it is still shown once.
    expect(await withoutNamesakes(ids.artists.slice(1), [boards.id])).toEqual([ids.artists[2]])
  })

  it('keeps the first of stubs with one name, puts an MBID ahead of them, and keeps every artist with an MBID', async () => {
    const first = await artistStub({ name: 'Chelcee Grimes', deezerId: 1 })
    const second = await artistStub({ name: 'Chelcee Grimes', deezerId: 2 })
    expect(await withoutNamesakes([first, second], [])).toEqual([first])

    const stub = await artistStub({ name: 'Tiga', deezerId: 3 })
    const tiga = await createArtist({ name: 'Tiga', mbid: '58e5332d-383e-414c-9917-776d7b1493a2' })
    expect(await withoutNamesakes([stub, tiga.id], [])).toEqual([tiga.id])

    const nirvana = await createArtist({ name: 'Nirvana', mbid: '5b11f4ce-a62d-471e-81fc-a69a8278c7da' })
    const sixties = await createArtist({ name: 'Nirvana', mbid: '9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6' })
    expect(await withoutNamesakes([nirvana.id, sixties.id], [])).toEqual([nirvana.id, sixties.id])
    expect(await withoutNamesakes([], [nirvana.id])).toEqual([])
  })
})
