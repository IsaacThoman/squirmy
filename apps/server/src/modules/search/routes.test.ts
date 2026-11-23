import type { AlbumSummary } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { oncePerTitle } from './routes.js'

const album = (id: string, title: string, artistCredit = 'SZA'): AlbumSummary => ({
  id, mbid: null, title, artistCredit, artists: [], year: 2024, type: 'album', artwork: null, availability: 'on_demand', trackCount: 0, ownedTrackCount: 0,
})

describe('oncePerTitle', () => {
  it('shows each album name of an artist once, the first standing for the copies', () => {
    // "SOS Deluxe: LANA" three times on the test instance: two explicit pressings and a clean one.
    const found = [album('a', 'SOS Deluxe: LANA'), album('b', 'SOS'), album('c', 'SOS Deluxe: LANA'), album('d', 'SOS Deluxe: LANA'), album('e', 'SOS Deluxe: LANA', 'Other Singer')]
    expect(oncePerTitle(found).map((one) => one.id)).toEqual(['a', 'b', 'e'])
    // A copy the library answer already shows is left out.
    expect(oncePerTitle(found, [album('own', 'SOS')]).map((one) => one.id)).toEqual(['a', 'e'])
  })
})
