import type { AlbumSummary, TrackAvailability } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { albumNote, albumPresentation, canFetch, isPlayable, trackLibraryToggle, UNAVAILABLE_LABEL, type Viewer } from './availability.js'

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

describe('trackLibraryToggle', () => {
  it('offers Remove only for the user\'s own save', () => {
    expect(trackLibraryToggle({ inLibrary: true, library: 'saved' })).toBe(true)
    expect(trackLibraryToggle({ inLibrary: false, library: null })).toBe(false)
  })

  it('offers nothing for collection songs and songs of an added album', () => {
    expect(trackLibraryToggle({ inLibrary: true, library: 'collection' })).toBeNull()
    expect(trackLibraryToggle({ inLibrary: true, library: 'album' })).toBeNull()
    // Saving one does not make it removable: it would stay in the library.
    expect(trackLibraryToggle({ inLibrary: true, library: 'collection' }, true)).toBeNull()
  })

  it('follows what the user just did ahead of the server', () => {
    expect(trackLibraryToggle({ inLibrary: false, library: null }, true)).toBe(true)
    expect(trackLibraryToggle({ inLibrary: true, library: 'saved' }, false)).toBe(false)
  })

  it('offers nothing when the server does not say, and falls back to inLibrary without a reason', () => {
    expect(trackLibraryToggle({})).toBeNull()
    expect(trackLibraryToggle({ inLibrary: true })).toBe(true)
  })
})
