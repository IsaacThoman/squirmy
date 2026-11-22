import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { matches, readLibraryFilter, readLibraryLayout, sortFor, sortsFor, writeLibraryFilter, writeLibraryLayout } from './library-state'

describe('library sorts', () => {
  it('match the iOS app: no year for songs, none for artists and playlists', () => {
    expect(sortsFor('all')).toEqual(['recent', 'title', 'artist', 'year'])
    expect(sortsFor('albums')).toEqual(['recent', 'title', 'artist', 'year'])
    expect(sortsFor('songs')).toEqual(['recent', 'title', 'artist'])
    expect(sortsFor('artists')).toEqual([])
    expect(sortsFor('playlists')).toEqual([])
  })

  it('keep the order chosen where it applies, and fall back to Recently added elsewhere', () => {
    expect(sortFor('albums', 'year')).toBe('year')
    expect(sortFor('songs', 'year')).toBe('recent')
    expect(sortFor('songs', 'title')).toBe('title')
  })
})

describe('matches', () => {
  it('finds every word, ignoring case and accents', () => {
    expect(matches('beyon blue', 'Blue Hour', 'Beyoncé')).toBe(true)
    expect(matches('blue night', 'Blue Hour')).toBe(false)
    expect(matches('', 'Anything')).toBe(true)
  })
})

describe('library preferences', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('keep the filter and the layout in this browser', () => {
    expect(readLibraryFilter()).toBe('all')
    expect(readLibraryLayout()).toBe('grid')
    writeLibraryFilter('songs')
    writeLibraryLayout('list')
    expect(readLibraryFilter()).toBe('songs')
    expect(readLibraryLayout()).toBe('list')
  })

  it('ignore what they do not know and storage that refuses', () => {
    localStorage.setItem('squirmy.library.filter', 'genres')
    expect(readLibraryFilter()).toBe('all')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => writeLibraryFilter('albums')).not.toThrow()
    expect(readLibraryFilter()).toBe('all')
    expect(readLibraryLayout()).toBe('grid')
  })
})
