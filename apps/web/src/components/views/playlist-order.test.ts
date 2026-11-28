import type { PlaylistItem } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { track } from '@/fixtures/catalog'
import { playlistOrder } from './playlist-order'

const item = (slug: string, title: string, artistCredit: string, album: string, addedAt: string, durationMs: number): PlaylistItem => {
  const base = track(slug)
  return { itemId: base.id, addedAt, track: { ...base, title, artistCredit, durationMs, album: base.album && { ...base.album, title: album } } }
}

const items = [
  item('amber', 'Zebra', 'The Kites', 'Paper Sky', '2026-01-03T00:00:00.000Z', 200_000),
  item('static-bloom', 'apple', 'Mira Vale', 'Blue Hour', '2026-01-01T00:00:00.000Z', 100_000),
  item('night-swimming', 'Éclair', 'Björk', 'Homogenic', '2026-01-02T00:00:00.000Z', 300_000),
]

describe('playlistOrder', () => {
  it('keeps the playlist’s order until asked for another', () => {
    expect(playlistOrder(items, '', 'custom')).toEqual([0, 1, 2])
  })

  it('sorts by title, artist, album, date added and length', () => {
    expect(playlistOrder(items, '', 'title')).toEqual([1, 2, 0])
    // "The Kites" sorts under K.
    expect(playlistOrder(items, '', 'artist')).toEqual([2, 0, 1])
    expect(playlistOrder(items, '', 'album')).toEqual([1, 2, 0])
    expect(playlistOrder(items, '', 'added')).toEqual([0, 2, 1])
    expect(playlistOrder(items, '', 'duration')).toEqual([1, 0, 2])
  })

  it('finds songs by every word typed, ignoring case and accents, and sorts what it finds', () => {
    expect(playlistOrder(items, 'bjork', 'custom')).toEqual([2])
    expect(playlistOrder(items, 'eclair homo', 'custom')).toEqual([2])
    expect(playlistOrder(items, 'blue', 'title')).toEqual([1])
    expect(playlistOrder(items, 'nothing like it', 'custom')).toEqual([])
  })
})
