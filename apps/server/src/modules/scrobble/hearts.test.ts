import { eq } from 'drizzle-orm'
import { describe, it, expect } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { likes } from '../../database/schema.js'
import { updateServerSettings } from '../../lib/settings.js'
import { signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { unlikeEntity } from '../userdata/likes.js'
import { saveConnection } from './connections.js'
import { syncHearts } from './hearts.js'

describe('heart sync', () => {
  useTestDatabase()
  const http = useHttpFixtures('hearts')

  it('validates a custom API URL, imports feedback from both providers and only exports local hearts once', async () => {
    await updateServerSettings({ lastFmKey: 'hearts-key', lastFmSecret: 'hearts-secret' })
    const user = await signIn({ settings: { syncListenBrainzHearts: true, syncLastFmHearts: true } })
    const app = await buildApp()
    try {
      const response = await app.inject({
        method: 'PUT', url: '/api/v1/me/scrobbling/listenbrainz', headers: user.headers,
        payload: { token: 'custom-token', apiUrl: 'https://scrobbles.example/lb/1' },
      })
      expect(response.statusCode, response.body).toBe(200)
      expect(response.json().services[0].apiUrl).toBe('https://scrobbles.example/lb/1/')
    } finally {
      await app.close()
    }
    await saveConnection(user.id, 'lastfm', 'other-token', 'other-user')
    const artist = await createArtist({ name: 'Beyoncé' })
    const { tracks } = await createAlbum({ artist, tracks: [
      { title: 'Déjà Vu' }, { title: 'Outside' },
      { title: 'Local', mbid: '046f957e-30ea-477b-a078-e30f4da52d68' },
      { title: 'Hated', mbid: '046f957e-30ea-477b-a078-e30f4da52d69' },
    ] })
    await db.insert(likes).values([tracks[2]!, tracks[3]!].map(track => ({
      userId: user.id, entityType: 'recording' as const, entityId: track.recordingId, createdAt: new Date('2023-01-01'),
    })))
    await syncHearts(user.id)
    const saved = () => db.select().from(likes).where(eq(likes.userId, user.id))
    expect((await saved()).map(row => [row.entityId, row.importedHeart])).toEqual(expect.arrayContaining([
      [tracks[0]!.recordingId, true], [tracks[1]!.recordingId, true], [tracks[2]!.recordingId, false],
    ]))
    expect(await saved()).toHaveLength(3)
    await unlikeEntity(user.id, 'track', tracks[0]!.recordingId)
    await syncHearts(user.id)
    expect(await saved()).toHaveLength(2)
    expect(http.requests.filter(request => request.startsWith('POST'))).toEqual([
      'POST https://scrobbles.example/lb/1/feedback/recording-feedback',
      'POST https://ws.audioscrobbler.com/2.0/',
    ])
  })
})
