import { describe, expect, it } from 'vitest'
import { patchEntity } from './patch'

const track = (id: string, liked: boolean) => ({ id, title: id, liked })

describe('patchEntity', () => {
  it('sets a field on every copy of the entity, wherever it is nested', () => {
    const page = { pages: [{ items: [track('a', false), track('b', false)], nextCursor: null }] }
    const album = { id: 'album', liked: false, discs: [{ disc: 1, tracks: [track('a', false)] }] }
    expect(patchEntity(page, 'a', { liked: true }).pages[0].items.map(item => item.liked)).toEqual([true, false])
    expect(patchEntity(album, 'a', { liked: true })).toEqual({ ...album, discs: [{ disc: 1, tracks: [track('a', true)] }] })
  })

  it('keeps everything it did not change, and only sets fields the entity has', () => {
    const data = { list: [track('a', false), track('b', false)], other: { id: 'x' } }
    const patched = patchEntity(data, 'b', { liked: true, wanted: true })
    expect(patched.list[0]).toBe(data.list[0])
    expect(patched.other).toBe(data.other)
    expect(patched.list[1]).toEqual(track('b', true))
    expect(patchEntity(data, 'nobody', { liked: true })).toBe(data)
    expect(patchEntity(undefined, 'a', { liked: true })).toBeUndefined()
  })
})
