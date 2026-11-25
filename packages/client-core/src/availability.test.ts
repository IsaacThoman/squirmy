import type { AlbumSummary, TrackAvailability } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { albumNote, albumPresentation, artistAvailabilityNote, artistReleaseCounts, canFetch, isPlayable, librarySave, UNAVAILABLE_LABEL, type Viewer } from './availability.js'

const admin: Viewer = { role: 'admin', canAcquire: false }
const fetcher: Viewer = { role: 'member', canAcquire: true }
const member: Viewer = { role: 'member', canAcquire: false }

const album = (availability: AlbumSummary['availability'], ownedTrackCount = 0, trackCount = 13) => ({ availability, trackCount, ownedTrackCount })

describe('canFetch', () => {
  it('is true for admins and members with canAcquire only', () => {
    expect(canFetch(admin)).toBe(true)
    expect(canFetch(fetcher)).toBe(true)
    expect(canFetch(member)).toBe(false)
    expect(canFetch(null)).toBe(false)
    expect(canFetch(undefined)).toBe(false)
  })
})

describe('isPlayable', () => {
  const cells: [TrackAvailability, boolean, boolean][] = [
    // availability, requester, non-requester
    ['server', true, true],
    ['on_demand', true, false],
    ['none', false, false],
  ]
  it.each(cells)('%s: requester %s, non-requester %s', (availability, requester, other) => {
    expect(isPlayable({ availability }, fetcher)).toBe(requester)
    expect(isPlayable({ availability }, admin)).toBe(requester)
    expect(isPlayable({ availability }, member)).toBe(other)
    expect(isPlayable({ availability }, null)).toBe(other)
  })
})

describe('albumPresentation and albumNote', () => {
  const table: [AlbumSummary['availability'], 'normal' | 'dimmed', 'normal' | 'dimmed', string | null][] = [
    // availability, requester, non-requester, non-requester's page line
    ['full', 'normal', 'normal', null],
    ['partial', 'normal', 'normal', '8 of 13 songs available'],
    ['on_demand', 'normal', 'dimmed', null],
    ['none', 'dimmed', 'dimmed', null],
  ]
  it.each(table)('%s: requester %s, non-requester %s', (availability, requester, other, note) => {
    const owned = availability === 'full' ? 13 : availability === 'partial' ? 8 : 0
    expect(albumPresentation({ availability }, fetcher)).toBe(requester)
    expect(albumPresentation({ availability }, member)).toBe(other)
    expect(albumPresentation({ availability }, null)).toBe(other)
    expect(albumNote(album(availability, owned), member)).toBe(note)
    expect(albumNote(album(availability, owned), fetcher)).toBeNull()
    expect(albumNote(album(availability, owned), admin)).toBeNull()
  })

  it('labels unavailable music with one phrase', () => {
    expect(UNAVAILABLE_LABEL).toBe('Not available')
  })
})

describe('librarySave', () => {
  it('is the heart: saved items offer Remove, others Save', () => {
    expect(librarySave({ liked: true })).toEqual({ saved: true, label: 'Remove from library' })
    expect(librarySave({ liked: false })).toEqual({ saved: false, label: 'Save to library' })
  })

  it('follows what the user just did ahead of the server', () => {
    expect(librarySave({ liked: false }, true)).toEqual({ saved: true, label: 'Remove from library' })
    expect(librarySave({ liked: true }, false)).toEqual({ saved: false, label: 'Save to library' })
  })
})

describe('artistAvailabilityNote', () => {
  const release = (availability: AlbumSummary['availability']) => ({ availability, trackCount: 10, ownedTrackCount: 0 }) as AlbumSummary
  const counted = { albums: [], releaseCount: 1200, ownedReleaseCount: 3 }

  it('tells someone who may not fetch how much of the discography plays', () => {
    expect(artistAvailabilityNote(counted, member)).toBe('3 of 1,200 releases available')
    expect(artistAvailabilityNote(counted, null)).toBe('3 of 1,200 releases available')
  })

  it('says nothing to a requester, or when everything plays', () => {
    expect(artistAvailabilityNote(counted, admin)).toBeNull()
    expect(artistAvailabilityNote(counted, fetcher)).toBeNull()
    expect(artistAvailabilityNote({ albums: [], releaseCount: 4, ownedReleaseCount: 4 }, member)).toBeNull()
  })

  it('counts the albums sent when an older server leaves the counts out', () => {
    const artist = { albums: [release('full'), release('on_demand'), release('none')] }
    expect(artistReleaseCounts(artist, member)).toEqual({ total: 3, playing: 1 })
    expect(artistReleaseCounts(artist, fetcher)).toEqual({ total: 3, playing: 2 })
    expect(artistAvailabilityNote(artist, member)).toBe('1 of 3 releases available')
  })
})
