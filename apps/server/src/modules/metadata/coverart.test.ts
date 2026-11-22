import { describe, expect, it } from 'vitest'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { getReleaseCover, getReleaseGroupCover } from './coverart.js'
import { fetchImage } from './images.js'

const okComputer = 'b1392450-e666-3926-a536-22c65f834433'
const okComputerCd = '52709206-8816-3c12-9ff6-f957f2f1eecf'
const unknown = '11111111-2222-4333-8444-555555555555'

describe('coverart', () => {
  useTestDatabase()
  const http = useHttpFixtures('coverart')

  it('returns the 1200 px front cover of a release and a release group', async () => {
    expect(await getReleaseCover(okComputerCd)).toMatch(/^https:\/\/coverartarchive\.org\/release\/52709206-8816-3c12-9ff6-f957f2f1eecf\/\d+-1200\.jpg$/)
    expect(await getReleaseGroupCover(okComputer)).toMatch(/^https:\/\/coverartarchive\.org\/release\/[0-9a-f-]{36}\/\d+-1200\.jpg$/)
  })

  it('returns null when there is no art', async () => {
    expect(await getReleaseCover(unknown)).toBeNull()
    expect(await getReleaseGroupCover(unknown)).toBeNull()
  })

  it('returns null without a request when the archive is switched off', async () => {
    await updateServerSettings({ coverArtArchiveEnabled: false })
    expect(await getReleaseCover(okComputerCd)).toBeNull()
    expect(http.requests).toEqual([])
    await updateServerSettings({ coverArtArchiveEnabled: true })
  })

  it('downloads images with a size cap', async () => {
    const image = await fetchImage('https://images.example.test/pixel.png')
    expect(image!.contentType).toBe('image/png')
    expect(image!.bytes.subarray(1, 4).toString()).toBe('PNG')
    expect(await fetchImage('https://images.example.test/pixel.png', { maxBytes: 10 })).toBeNull()
    expect(await fetchImage('https://images.example.test/missing.png')).toBeNull()
    expect(await fetchImage('https://images.example.test/page.html')).toBeNull()
  })

  it('follows redirects only to public https URLs', async () => {
    expect((await fetchImage('https://images.example.test/redirect-moved.png'))!.contentType).toBe('image/png')
    expect(await fetchImage('https://images.example.test/redirect-internal.png')).toBeNull()
    expect(await fetchImage('https://images.example.test/redirect-plain.png')).toBeNull()
    expect(await fetchImage('http://images.example.test/pixel.png')).toBeNull()
    expect(await fetchImage('https://127.0.0.1/pixel.png')).toBeNull()
    expect(http.requests).toEqual([
      'GET https://images.example.test/redirect-moved.png', 'GET https://images.example.test/pixel.png',
      'GET https://images.example.test/redirect-internal.png', 'GET https://images.example.test/redirect-plain.png',
    ])
  })
})
