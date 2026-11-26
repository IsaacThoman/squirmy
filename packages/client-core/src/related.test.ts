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

  it('lists the versions the server names first, and leaves them out of more', () => {
    const release = (id: string, title: string, type: 'album' | 'single' | 'ep' = 'album') => ({ id, title, type }) as unknown as AlbumSummary
    // The artist page lists the deluxe once, as the album: only the server knows it.
    const artist = { mbid: null, albums: [release('1', 'So Close to What'), release('2', 'Think Later'), release('3', 'So Close to What (Live)')] }
    const deluxe = release('9', 'SO CLOSE TO WHAT???')
    const renamed = release('8', 'So Close: The Remixes')
    const { versions, more } = relatedAlbums({ id: '1', title: 'So Close to What', versions: [deluxe, renamed, release('1', 'So Close to What')] }, artist)
    expect(versions.map(album => album.id)).toEqual(['9', '8', '3'])
    expect(more.map(album => album.id)).toEqual(['2'])
    // A version the artist page lists too shows once.
    expect(relatedAlbums({ id: '1', title: 'So Close to What', versions: [release('3', 'So Close to What (Live)')] }, artist).versions.map(album => album.id)).toEqual(['3'])
    // Without the artist (or for Various Artists) the server's versions still show.
    expect(relatedAlbums({ id: '9', title: 'SO CLOSE TO WHAT???', versions: [release('1', 'So Close to What')] }, undefined)).toEqual({ versions: [release('1', 'So Close to What')], more: [] })
    // From the deluxe's page the standard edition is a version, not more by the artist.
    const fromDeluxe = relatedAlbums({ id: '9', title: 'SO CLOSE TO WHAT???', versions: [release('1', 'So Close to What')] }, artist)
    expect(fromDeluxe.versions.map(album => album.id)).toEqual(['1', '3'])
    expect(fromDeluxe.more.map(album => album.id)).toEqual(['2'])
  })
})
