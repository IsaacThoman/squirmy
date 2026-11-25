import type { AlbumSummary } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { albumTitleKey, relatedAlbums } from './related.js'

describe('related albums', () => {
  it('gives versions of one album one title key', () => {
    const key = albumTitleKey('Watch The Throne')
    expect(albumTitleKey('Watch The Throne (Deluxe)')).toBe(key)
    expect(albumTitleKey('Watch the Throne - Deluxe Edition')).toBe(key)
    expect(albumTitleKey('Watch The Throne (Deluxe) [Explicit]')).toBe(key)
    expect(albumTitleKey('Watch The Throne Tour')).not.toBe(key)
    expect(albumTitleKey('Pokémon')).toBe(albumTitleKey('Pokemon'))
    // Only punctuation: kept, so such titles do not all become one album.
    expect(albumTitleKey('!!!')).not.toBe(albumTitleKey('???'))
  })

  it('splits an artist’s other releases into versions and more, albums first', () => {
    const release = (id: string, title: string, type: 'album' | 'single' | 'ep') => ({ id, title, type }) as unknown as AlbumSummary
    const artist = {
      mbid: null,
      albums: [release('1', 'Blue Hour', 'album'), release('2', 'Low Tide', 'single'), release('3', 'Blue Hour (Deluxe)', 'album'), release('4', 'Paper Moons', 'ep'), release('5', 'Glass', 'album')],
    }
    const { versions, more } = relatedAlbums({ id: '1', title: 'Blue Hour' }, artist)
    expect(versions.map(album => album.id)).toEqual(['3'])
    expect(more.map(album => album.id)).toEqual(['5', '4', '2'])
    // Each other album once, by its plainest title.
    const editions = { ...artist, albums: [...artist.albums, release('6', 'Glass (Remastered)', 'album')] }
    expect(relatedAlbums({ id: '1', title: 'Blue Hour' }, editions).more.map(album => album.id)).toEqual(['5', '4', '2'])
    expect(relatedAlbums({ id: '1', title: 'Blue Hour' }, { ...artist, mbid: '89ad4ac3-39f7-470e-963a-56509c546377' })).toEqual({ versions: [], more: [] })
    expect(relatedAlbums({ id: '1', title: 'Blue Hour' }, undefined)).toEqual({ versions: [], more: [] })
  })
})
