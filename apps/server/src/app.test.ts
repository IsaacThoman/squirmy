import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { resetConfig } from './config.js'
import { db } from './database/client.js'
import { users } from './database/schema.js'
import { newId } from './lib/ids.js'
import { signIn } from './test/api.js'
import { useTestDatabase } from './test/database.js'

describe('server kernel', () => {
  useTestDatabase()

  it('answers the health and readiness checks', async () => {
    const app = await buildApp()
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok', service: 'squirmy' })
    expect((await app.inject({ url: '/ready' })).json()).toEqual({ status: 'ready' })
    await app.close()
  })

  it('has a migrated database with trigram search', async () => {
    await db.insert(users).values({ id: newId(), username: 'Isaac', usernameKey: 'isaac', passwordHash: 'x' })
    const rows = await db.select().from(users)
    expect(rows).toHaveLength(1)
    const [row] = await db.execute<{ score: number }>(sql`select similarity('radiohead', 'radiohed') as score`)
    expect(Number(row?.score)).toBeGreaterThan(0.5)
  })

  it('answers unknown API routes with a JSON 404 and allows the Vite dev origin', async () => {
    const app = await buildApp()
    const missing = await app.inject({ url: '/api/v1/nothing-here' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('not_found')
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/auth/me',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' },
    })
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    const foreign = await app.inject({ url: '/health', headers: { origin: 'https://elsewhere.example' } })
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined()
    await app.close()
  })

  it('compresses JSON and answers unchanged reads with 304', async () => {
    const app = await buildApp()
    const user = await signIn()
    for (let index = 0; index < 40; index++) {
      await app.inject({ method: 'POST', url: '/api/v1/playlists', headers: user.headers, payload: { name: `Playlist number ${index}` } })
    }
    const url = '/api/v1/playlists?limit=50'
    const plain = await app.inject({ url, headers: user.headers })
    expect(plain.statusCode).toBe(200)
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.headers['cache-control']).toBe('private, no-cache')
    const etag = plain.headers.etag as string
    expect(etag).toMatch(/^W\/"/)

    const brotli = await app.inject({ url, headers: { ...user.headers, 'accept-encoding': 'br, gzip' } })
    expect(brotli.headers['content-encoding']).toBe('br')
    expect(brotli.headers.etag).toBe(etag)
    expect(brotliDecompressSync(brotli.rawPayload).toString()).toBe(plain.body)
    const gzip = await app.inject({ url, headers: { ...user.headers, 'accept-encoding': 'gzip' } })
    expect(gunzipSync(gzip.rawPayload).toString()).toBe(plain.body)

    // Proxies hand ETags back weakened or in a list; either still matches.
    for (const header of [etag, etag.slice(2), `"other", ${etag}`]) {
      const again = await app.inject({ url, headers: { ...user.headers, 'if-none-match': header } })
      expect(again.statusCode, header).toBe(304)
      expect(again.body).toBe('')
      expect(again.headers.etag).toBe(etag)
    }
    await app.inject({ method: 'POST', url: '/api/v1/playlists', headers: user.headers, payload: { name: 'One more' } })
    const changed = await app.inject({ url, headers: { ...user.headers, 'if-none-match': etag } })
    expect(changed.statusCode).toBe(200)
    expect(changed.headers.etag).not.toBe(etag)

    // Errors carry no validators.
    const missing = await app.inject({ url: `/api/v1/playlists/${newId()}`, headers: user.headers })
    expect(missing.statusCode).toBe(404)
    expect(missing.headers.etag).toBeUndefined()
    await app.close()
  })

  describe('with a built web app', () => {
    let dist = ''
    afterAll(async () => {
      delete process.env.SQUIRMY_WEB_DIST
      resetConfig()
      await rm(dist, { recursive: true, force: true })
    })

    it('serves files, falls back to index.html and never shadows the API', async () => {
      dist = await mkdtemp(path.join(tmpdir(), 'squirmy-web-'))
      await mkdir(path.join(dist, 'assets'))
      await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Squirmy</title>')
      await writeFile(path.join(dist, 'assets', 'app-abc123.js'), `console.log(${JSON.stringify('squirmy '.repeat(400))})`)
      await writeFile(path.join(dist, 'assets', 'cover-abc123.png'), Buffer.alloc(4096, 1))
      process.env.SQUIRMY_WEB_DIST = dist
      resetConfig()
      const app = await buildApp()

      const asset = await app.inject({ url: '/assets/app-abc123.js' })
      expect(asset.statusCode).toBe(200)
      expect(asset.headers['cache-control']).toContain('immutable')
      const compressed = await app.inject({ url: '/assets/app-abc123.js', headers: { 'accept-encoding': 'br' } })
      expect(compressed.headers['content-encoding']).toBe('br')
      expect(brotliDecompressSync(compressed.rawPayload).toString()).toBe(asset.body)
      const image = await app.inject({ url: '/assets/cover-abc123.png', headers: { 'accept-encoding': 'br, gzip' } })
      expect(image.statusCode).toBe(200)
      expect(image.headers['content-encoding']).toBeUndefined()

      for (const url of ['/', '/albums/123', '/library?tab=artists']) {
        const page = await app.inject({ url })
        expect(page.statusCode).toBe(200)
        expect(page.body).toContain('<title>Squirmy</title>')
        expect(page.headers['cache-control']).toBe('no-cache')
      }

      for (const url of ['/api/v1/nothing', '/socket.io/x', '/api']) {
        const response = await app.inject({ url })
        expect(response.statusCode, url).toBe(404)
        expect(response.json().error.code).toBe('not_found')
      }
      // /rest belongs to the Subsonic module, which answers even unknown methods itself.
      const subsonic = await app.inject({ url: '/rest/nothing.view' })
      expect(subsonic.headers['content-type']).toMatch(/^text\/xml/)
      expect(subsonic.body).toContain('<subsonic-response')
      expect((await app.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404)
      expect((await app.inject({ url: '/health' })).json().status).toBe('ok')
      await app.close()
    })
  })
})
