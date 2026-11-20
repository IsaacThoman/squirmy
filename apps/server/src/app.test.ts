import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { resetConfig } from './config.js'
import { db } from './database/client.js'
import { users } from './database/schema.js'
import { newId } from './lib/ids.js'
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
      await writeFile(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)')
      process.env.SQUIRMY_WEB_DIST = dist
      resetConfig()
      const app = await buildApp()

      const asset = await app.inject({ url: '/assets/app-abc123.js' })
      expect(asset.statusCode).toBe(200)
      expect(asset.headers['cache-control']).toContain('immutable')

      for (const url of ['/', '/albums/123', '/library?tab=artists']) {
        const page = await app.inject({ url })
        expect(page.statusCode).toBe(200)
        expect(page.body).toContain('<title>Squirmy</title>')
        expect(page.headers['cache-control']).toBe('no-cache')
      }

      for (const url of ['/api/v1/nothing', '/rest/ping.view', '/socket.io/x', '/api']) {
        const response = await app.inject({ url })
        expect(response.statusCode, url).toBe(404)
        expect(response.json().error.code).toBe('not_found')
      }
      expect((await app.inject({ method: 'POST', url: '/somewhere' })).statusCode).toBe(404)
      expect((await app.inject({ url: '/health' })).json().status).toBe('ok')
      await app.close()
    })
  })
})
