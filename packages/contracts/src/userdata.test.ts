import { describe, expect, it } from 'vitest'
import { CreatePlaylistRequest, LibraryEntityType, PlaylistDetail, SMART_CONDITION_LIMIT, SmartPlaylistRules, UpdatePlaylistRequest } from './userdata.js'

describe('LibraryEntityType', () => {
  it('saves albums and tracks only', () => {
    expect(LibraryEntityType.options).toEqual(['album', 'track'])
    expect(() => LibraryEntityType.parse('artist')).toThrow()
  })
})

describe('SmartPlaylistRules', () => {
  const base = { source: 'library', match: 'all', sort: 'random', limit: null } as const

  it('takes conditions of every kind and one level of groups', () => {
    const rules = {
      ...base,
      conditions: [
        { field: 'genre', op: 'contains', value: 'jazz' },
        { field: 'year', op: 'between', value: 1960, to: 1979 },
        { field: 'decade', op: 'isNot', value: 1980 },
        { field: 'lastPlayed', op: 'notInLast', value: 3, unit: 'months' },
        { field: 'addedAt', op: 'after', value: '2024-06-01' },
        { match: 'any', conditions: [{ field: 'liked', value: true }, { field: 'rating', op: 'gt', value: 3 }] },
      ],
    }
    expect(SmartPlaylistRules.parse(rules)).toEqual(rules)
    expect(CreatePlaylistRequest.parse({ name: 'Jazz', rules }).rules).toEqual(rules)
    expect(UpdatePlaylistRequest.parse({ rules }).rules).toEqual(rules)
  })

  it('counts the conditions inside groups against the limit', () => {
    const condition = { field: 'liked', value: true }
    const half = Array.from({ length: SMART_CONDITION_LIMIT / 2 }, () => condition)
    expect(SmartPlaylistRules.safeParse({ ...base, conditions: [...half, { match: 'any', conditions: half }] }).success).toBe(true)
    expect(SmartPlaylistRules.safeParse({ ...base, conditions: [...half, condition, { match: 'any', conditions: half }] }).success).toBe(false)
  })

  it('still reads playlists from servers before smart playlists', () => {
    const detail = { id: '00000000-0000-4000-8000-000000000001', name: 'Old', description: null, ownerId: '00000000-0000-4000-8000-000000000002', ownerName: 'mira', isPublic: false, trackCount: 0, durationMs: 0, artworks: [], updatedAt: '2026-01-01T00:00:00.000Z', items: [] }
    expect(PlaylistDetail.parse(detail)).toEqual(detail)
  })
})
