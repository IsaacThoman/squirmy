import { describe, expect, it } from 'vitest'
import { patchEntities } from './changes.js'
import { cachedInLibrary, heartFields, heartRollback } from './hearts.js'

const id = '00000000-0000-4000-8000-000000000001'

describe('hearts', () => {
  it('puts a saved track or artist in the library at once, and leaves a removal to the server', () => {
    expect(heartFields('track', true)).toEqual({ liked: true, inLibrary: true })
    expect(heartFields('artist', true)).toEqual({ liked: true, inLibrary: true })
    expect(heartFields('album', true)).toEqual({ liked: true })
    expect(heartFields('track', false)).toEqual({ liked: false })
  })

  it('reads what the cache said before, from the first answer that carries the item', () => {
    const answers = [
      { items: [{ id: 'other', inLibrary: true }] },
      { album: { tracks: [{ id, liked: false, inLibrary: false }] } },
      [{ id, inLibrary: true }],
    ]
    expect(cachedInLibrary(answers, id)).toBe(false)
    expect(cachedInLibrary([{ id, liked: false }], id)).toBeUndefined()
    expect(cachedInLibrary([], id)).toBeUndefined()
  })

  it('takes a refused save back out of the library, unless it was there already', () => {
    const page = { tracks: [{ id, liked: false, inLibrary: false }] }
    const before = cachedInLibrary([page], id)
    const saved = patchEntities(page, new Map([[id, heartFields('track', true)]]))
    expect(saved.tracks[0]).toEqual({ id, liked: true, inLibrary: true })
    const refused = patchEntities(saved, new Map([[id, heartRollback('track', true, before)]]))
    expect(refused.tracks[0]).toEqual({ id, liked: false, inLibrary: false })

    // On a saved album, the track stays in the library when its own heart is refused.
    expect(heartRollback('track', true, true)).toEqual({ liked: false, inLibrary: true })
  })

  it('puts back only the heart of a refused removal, or when nothing was cached', () => {
    expect(heartRollback('track', false, true)).toEqual({ liked: true })
    expect(heartRollback('track', true, undefined)).toEqual({ liked: false })
    expect(heartRollback('album', true, false)).toEqual({ liked: false })
  })
})
