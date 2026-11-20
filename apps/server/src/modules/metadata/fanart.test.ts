import { describe, expect, it } from 'vitest'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { getArtistImages } from './fanart.js'

const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
const unknown = '11111111-2222-4333-8444-555555555555'

describe('fanart', () => {
  useTestDatabase()
  const http = useHttpFixtures('fanart')

  it('does nothing without an API key', async () => {
    expect(await getArtistImages(radiohead)).toBeNull()
    expect(http.requests).toEqual([])
  })

  it('returns thumbnails and backgrounds, most liked first', async () => {
    await updateServerSettings({ fanartKey: 'test-fanart-key' })
    expect(await getArtistImages(radiohead)).toEqual({
      thumbnails: [
        'https://assets.fanart.tv/fanart/music/a74b1b7f-71a5-4011-9441-d0b5e4122711/artistthumb/radiohead-4fe1f4ea2e2e4.jpg',
        'https://assets.fanart.tv/fanart/music/a74b1b7f-71a5-4011-9441-d0b5e4122711/artistthumb/radiohead-5096a4f4d4b7c.jpg',
      ],
      backgrounds: ['https://assets.fanart.tv/fanart/music/a74b1b7f-71a5-4011-9441-d0b5e4122711/artistbackground/radiohead-4f8c1d3a3c6f1.jpg'],
    })
  })

  it('returns null for an artist fanart.tv does not know', async () => {
    expect(await getArtistImages(unknown)).toBeNull()
  })
})
