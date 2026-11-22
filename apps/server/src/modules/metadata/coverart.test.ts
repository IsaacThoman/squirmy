import { describe, expect, it } from 'vitest'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { getReleaseCover, getReleaseGroupCover, originalFront } from './coverart.js'
import { downloadImage, fetchImage } from './images.js'

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

  it('fetches the original front while archive.org has not derived the sized one yet', async () => {
    // HYPE MEDIA JAPAN: Hype Selects, Vol. 1, uploaded days before: front-500 redirects to a
    // thumbnail that answers 404, while the original is there.
    const fresh = 'https://coverartarchive.org/release-group/6c5f8e76-87b9-4480-8d2f-432180feba69/front-500'
    const result = await downloadImage(fresh)
    expect(result).toMatchObject({ gone: false, image: { contentType: 'image/jpeg' } })
    expect(http.requests.slice(-4)).toEqual([
      `GET ${fresh}`,
      'GET https://archive.org/download/mbid-d3e32178-af15-4856-aa34-7399e5e1d93c/mbid-d3e32178-af15-4856-aa34-7399e5e1d93c-46748862495_thumb500.jpg',
      'GET https://coverartarchive.org/release-group/6c5f8e76-87b9-4480-8d2f-432180feba69/front',
      'GET https://archive.org/download/mbid-d3e32178-af15-4856-aa34-7399e5e1d93c/mbid-d3e32178-af15-4856-aa34-7399e5e1d93c-46748862495.jpg',
    ])

    // A group without a cover is gone once the original is missing too.
    const none = 'https://coverartarchive.org/release-group/18cf83bd-c54c-4c97-b91f-bb64bbc7c340/front-500'
    expect(await downloadImage(none)).toEqual({ image: null, gone: true })
    expect(http.requests.slice(-2)).toEqual([`GET ${none}`, 'GET https://coverartarchive.org/release-group/18cf83bd-c54c-4c97-b91f-bb64bbc7c340/front'])
  })

  it('names the original only for sized Cover Art Archive fronts', () => {
    expect(originalFront('https://coverartarchive.org/release/52709206-8816-3c12-9ff6-f957f2f1eecf/front-1200'))
      .toBe('https://coverartarchive.org/release/52709206-8816-3c12-9ff6-f957f2f1eecf/front')
    expect(originalFront('https://coverartarchive.org/release-group/52709206-8816-3c12-9ff6-f957f2f1eecf/front')).toBeNull()
    expect(originalFront('https://coverartarchive.org/release-group/52709206-8816-3c12-9ff6-f957f2f1eecf/back-500')).toBeNull()
    expect(originalFront('https://cdn-images.dzcdn.net/images/cover/abc/front-500')).toBeNull()
  })
})
