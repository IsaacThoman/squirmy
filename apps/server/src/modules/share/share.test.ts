import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  ApiErrorBody, PublicShare, SHARE_LIMIT, ShareLink, ShareLinkPage, ShareTrackPlayback,
} from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { mediaFiles, shares, users } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { hashToken } from '../../lib/crypto.js'
import { newId } from '../../lib/ids.js'
import { invalidateServerSettings } from '../../lib/settings.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createLibraryRoot } from '../../test/factories.js'
import { sweepShares } from './index.js'
import { EXPIRED_KEPT_MS } from './links.js'
import { openStreamKey, sealStreamKey } from './playback.js'
import { previewPath, PREVIEW_KEPT_MS } from './preview.js'
import { SHARE_RATE_LIMITS } from './routes.js'

const run = promisify(execFile)

/** Seconds of audio in a file, by decoding it. */
async function decodedSeconds(file: string): Promise<number> {
  const { stderr } = await run('ffmpeg', ['-v', 'info', '-nostdin', '-i', file, '-f', 'null', '-'])
  const times = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)]
  const [, h, m, s] = times.at(-1)!
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}

describe('share links', () => {
  useTestDatabase()
  let app: FastifyInstance
  let root: string
  let admin: { authorization: string }
  let member: Awaited<ReturnType<typeof signIn>>
  let other: Awaited<ReturnType<typeof signIn>>
  let album: Awaited<ReturnType<typeof createAlbum>>
  let elsewhere: Awaited<ReturnType<typeof createAlbum>>
  let fileBytes: Buffer
  // Each anonymous request comes from an address of its own, so the rate limits stay out of the
  // way except in the test about them.
  let address = 0
  const nextAddress = () => `198.18.${(++address >> 8) & 255}.${address & 255}`

  const call = (options: InjectOptions) => app.inject(options)
  const anon = (url: string, options: InjectOptions = {}) => app.inject({ url, remoteAddress: nextAddress(), ...options })
  const settings = async (patch: Record<string, unknown>) => {
    const response = await call({ method: 'PATCH', url: '/api/v1/admin/settings', headers: admin, payload: patch })
    expect(response.statusCode, response.body).toBe(200)
    invalidateServerSettings()
  }
  const create = async (payload: Record<string, unknown>, headers = member.headers) =>
    body(await call({ method: 'POST', url: '/api/v1/me/shares', headers, payload }), ShareLink)
  const tokenOf = (link: ShareLink) => link.url!.slice('/s/'.length)
  const page = async (token: string) => body(await anon(`/api/v1/share/${token}`), PublicShare)
  const playback = async (token: string, trackId: string) => body(await anon(`/api/v1/share/${token}/tracks/${trackId}/playback`), ShareTrackPlayback)

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    const setup = await call({ method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' } })
    admin = { authorization: `Bearer ${setup.json().token}` }
    member = await signIn({ username: 'mira' })
    other = await signIn({ username: 'lune' })

    root = await mkdtemp(path.join(tmpdir(), 'squirmy-share-'))
    const rootId = (await createLibraryRoot({ path: root })).id
    // Long enough that a 30 second preview is a cut; very quiet, as every fixture.
    const relPath = 'Mira Vale/Blue Hour/01 Night.flac'
    const file = await makeTone(root, { path: relPath, durationSec: 34, tags: { title: 'Night Swimming', artist: 'Mira Vale' } })
    fileBytes = await readFile(file)
    album = await createAlbum({ title: 'Blue Hour', owned: [0], rootId, tracks: [{ title: 'Night Swimming', durationMs: 34_000 }, { title: 'Not Here' }] })
    const info = await stat(file)
    await db.update(mediaFiles).set({ relPath, size: fileBytes.length, mtime: info.mtime, durationMs: 34_000 }).where(eq(mediaFiles.id, album.tracks[0]!.fileId!))
    elsewhere = await createAlbum({ title: 'Elsewhere', owned: true, rootId, tracks: [{ title: 'Other Song' }] })
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
    await rm(root, { recursive: true, force: true })
  })

  it('makes an unguessable link and stores only its hash', async () => {
    const link = await create({ kind: 'album', id: album.albumId, expiresIn: '7d' })
    expect(link.url).toMatch(/^\/s\/[A-Za-z0-9_-]{43}$/)
    expect(link).toMatchObject({ kind: 'album', targetId: album.albumId, title: 'Blue Hour', expired: false, openCount: 0 })
    const days = (Date.parse(link.expiresAt!) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(6.9)
    expect(days).toBeLessThanOrEqual(7)
    const [row] = await db.select().from(shares).where(eq(shares.id, link.id))
    expect(row!.tokenHash).toBe(hashToken(tokenOf(link)))
    expect(JSON.stringify(row)).not.toContain(tokenOf(link))

    // The list never shows the token again.
    const list = body(await call({ url: '/api/v1/me/shares', headers: member.headers }), ShareLinkPage)
    expect(list.items.map((item) => item.id)).toContain(link.id)
    expect(list.items.every((item) => item.url === undefined && item.createdBy === undefined)).toBe(true)

    const never = await create({ kind: 'album', id: album.albumId, expiresIn: 'never' })
    expect(never.expiresAt).toBeNull()
  })

  it('answers the public page with exactly what it shows, and nothing about accounts or files', async () => {
    const link = await create({ kind: 'album', id: album.albumId })
    const response = await anon(`/api/v1/share/${tokenOf(link)}`)
    const shared = body(response, PublicShare)
    expect(Object.keys(shared).sort()).toEqual(['artistCredit', 'artwork', 'durationMs', 'expiresAt', 'kind', 'playback', 'serverName', 'title', 'tracks', 'year'])
    expect(shared).toEqual({
      kind: 'album', title: 'Blue Hour', artistCredit: album.artist.name, year: 2024, artwork: null,
      durationMs: 34_000 + album.tracks[1]!.durationMs, playback: 'previews', expiresAt: link.expiresAt, serverName: 'Squirmy',
      tracks: [
        { id: album.tracks[0]!.recordingId, title: 'Night Swimming', artistCredit: album.artist.name, albumTitle: null, artwork: null, durationMs: 34_000, disc: 1, position: 1, explicit: null, available: true },
        { id: album.tracks[1]!.recordingId, title: 'Not Here', artistCredit: album.artist.name, albumTitle: null, artwork: null, durationMs: album.tracks[1]!.durationMs, disc: 1, position: 2, explicit: null, available: false },
      ],
    })
    for (const secret of [member.id, member.username, album.tracks[0]!.fileId!, 'Blue Hour/01', root, album.artist.id, link.id]) {
      expect(response.body).not.toContain(secret)
    }
    // Counted for the creator's list.
    const [row] = await db.select().from(shares).where(eq(shares.id, link.id))
    expect(row!.openCount).toBe(1)
  })

  it('shows a playlist as it is now, by its name alone', async () => {
    const playlist = (await call({ method: 'POST', url: '/api/v1/playlists', headers: member.headers, payload: { name: 'Late drive', description: 'private words' } })).json()
    const link = await create({ kind: 'playlist', id: playlist.id })
    expect((await page(tokenOf(link))).tracks).toEqual([])
    await call({ method: 'POST', url: `/api/v1/playlists/${playlist.id}/items`, headers: member.headers, payload: { tracks: [{ trackId: elsewhere.tracks[0]!.recordingId, albumId: elsewhere.albumId }] } })
    const shared = await page(tokenOf(link))
    expect(shared).toMatchObject({ kind: 'playlist', title: 'Late drive', artistCredit: null })
    expect(shared.tracks).toEqual([expect.objectContaining({ title: 'Other Song', albumTitle: 'Elsewhere', disc: null, position: null, available: true })])
    expect(JSON.stringify(shared)).not.toContain('private words')
    expect(JSON.stringify(shared)).not.toContain('mira')

    // Someone else's private playlist cannot be shared; their public one can, until it is private again.
    const theirs = (await call({ method: 'POST', url: '/api/v1/playlists', headers: other.headers, payload: { name: 'Theirs', isPublic: false } })).json()
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/me/shares', headers: member.headers, payload: { kind: 'playlist', id: theirs.id } }), 404)).toBe('playlist_not_found')
    await call({ method: 'PATCH', url: `/api/v1/playlists/${theirs.id}`, headers: other.headers, payload: { isPublic: true } })
    const borrowed = await create({ kind: 'playlist', id: theirs.id })
    expect((await page(tokenOf(borrowed))).title).toBe('Theirs')
    await call({ method: 'PATCH', url: `/api/v1/playlists/${theirs.id}`, headers: other.headers, payload: { isPublic: false } })
    expect(errorCode(await anon(`/api/v1/share/${tokenOf(borrowed)}`), 404)).toBe('share_not_found')
  })

  it('shares one track with its album as context', async () => {
    const link = await create({ kind: 'track', id: album.tracks[0]!.recordingId, albumId: album.albumId })
    expect(link).toMatchObject({ kind: 'track', title: 'Night Swimming', subtitle: album.artist.name })
    const shared = await page(tokenOf(link))
    expect(shared).toMatchObject({ kind: 'track', title: 'Night Swimming', year: 2024 })
    expect(shared.tracks).toEqual([expect.objectContaining({ id: album.tracks[0]!.recordingId, albumTitle: 'Blue Hour', available: true })])
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/me/shares', headers: member.headers, payload: { kind: 'track', id: newId() } }), 404)).toBe('track_not_found')
  })

  it('answers the same 404 for unknown, malformed, expired, revoked and disabled links', async () => {
    const expired = await create({ kind: 'album', id: album.albumId, expiresIn: '1d' })
    await db.update(shares).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(shares.id, expired.id))
    const revoked = await create({ kind: 'album', id: album.albumId })
    expect((await call({ method: 'DELETE', url: `/api/v1/me/shares/${revoked.id}`, headers: member.headers })).statusCode).toBe(200)
    const disabledUser = await signIn({ username: 'gone' })
    const ofDisabled = await create({ kind: 'album', id: album.albumId }, disabledUser.headers)
    await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabledUser.id))

    const bodies = new Set<string>()
    for (const token of ['A'.repeat(43), 'short', 'not a token!', tokenOf(expired), tokenOf(revoked), tokenOf(ofDisabled)]) {
      const response = await anon(`/api/v1/share/${encodeURIComponent(token)}`)
      expect(response.statusCode, token).toBe(404)
      bodies.add(response.body)
      expect((await anon(`/api/v1/share/${encodeURIComponent(token)}/tracks/${album.tracks[0]!.recordingId}/playback`)).body).toBe(response.body)
    }
    expect(bodies.size).toBe(1)
    expect(ApiErrorBody.parse(JSON.parse([...bodies][0]!)).error.code).toBe('share_not_found')

    // The expired link stays listed, marked, until the sweep.
    const listed = body(await call({ url: '/api/v1/me/shares', headers: member.headers }), ShareLinkPage).items.find((item) => item.id === expired.id)
    expect(listed?.expired).toBe(true)
  })

  it('turns every link off and back on with the server setting, keeping them', async () => {
    const link = await create({ kind: 'album', id: album.albumId })
    const { url } = await playback(tokenOf(link), album.tracks[0]!.recordingId)
    await settings({ sharingEnabled: false })
    try {
      expect(errorCode(await anon(`/api/v1/share/${tokenOf(link)}`), 404)).toBe('share_not_found')
      expect(errorCode(await anon(url), 404)).toBe('share_not_found')
      expect(errorCode(await call({ method: 'POST', url: '/api/v1/me/shares', headers: member.headers, payload: { kind: 'album', id: album.albumId } }), 403)).toBe('sharing_disabled')
      expect((await call({ url: '/api/v1/setup/status' })).json().sharingEnabled).toBe(false)
      // Still there, for the creator and the admins.
      expect(body(await call({ url: '/api/v1/me/shares', headers: member.headers }), ShareLinkPage).items.some((item) => item.id === link.id)).toBe(true)
    } finally {
      await settings({ sharingEnabled: true })
    }
    expect((await page(tokenOf(link))).title).toBe('Blue Hour')
  })

  it('plays 30 second previews by default, cut on the server', async () => {
    const link = await create({ kind: 'album', id: album.albumId })
    const token = tokenOf(link)
    const song = await playback(token, album.tracks[0]!.recordingId)
    expect(song).toMatchObject({ preview: true, mime: 'audio/mpeg', durationMs: 30_000 })
    expect(song.url).toMatch(/^\/api\/v1\/share\/stream\?key=[\w-]+$/)
    expect(song.url).not.toContain(album.tracks[0]!.fileId!)
    const hours = (Date.parse(song.expiresAt) - Date.now()) / 3_600_000
    expect(hours).toBeGreaterThan(2.9)
    expect(hours).toBeLessThanOrEqual(3)

    const response = await anon(song.url)
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('audio/mpeg')
    const out = path.join(root, 'preview.mp3')
    await writeFile(out, response.rawPayload)
    const seconds = await decodedSeconds(out)
    expect(seconds).toBeGreaterThan(29)
    expect(seconds).toBeLessThanOrEqual(30.1)
    // Ranges work, for Safari's first probe and for seeking.
    const ranged = await anon(song.url, { headers: { range: 'bytes=0-1' } })
    expect(ranged.statusCode).toBe(206)
    expect(ranged.headers['content-range']).toBe(`bytes 0-1/${response.rawPayload.length}`)

    // A song not owned does not play, and neither does one outside the shared item.
    expect(errorCode(await anon(`/api/v1/share/${token}/tracks/${album.tracks[1]!.recordingId}/playback`), 404)).toBe('not_available')
    expect(errorCode(await anon(`/api/v1/share/${token}/tracks/${elsewhere.tracks[0]!.recordingId}/playback`), 404)).toBe('not_available')
    // Nor does a key sealed for another file, or one tampered with.
    const sealed = song.url.split('key=').at(-1)!
    const key = openStreamKey(sealed)!
    const forged = sealStreamKey({ ...key, fileId: elsewhere.tracks[0]!.fileId! })
    expect(errorCode(await anon(`/api/v1/share/stream?key=${forged}`), 404)).toBe('not_available')
    const flipped = `${sealed.slice(0, 20)}${sealed[20] === 'A' ? 'B' : 'A'}${sealed.slice(21)}`
    expect(errorCode(await anon(`/api/v1/share/stream?key=${flipped}`), 404)).toBe('share_not_found')
    const stale = sealStreamKey({ ...key, expiresAt: Date.now() - 1 })
    expect(errorCode(await anon(`/api/v1/share/stream?key=${stale}`), 404)).toBe('share_not_found')
    // A key may not ask for the whole file while the server plays previews.
    const whole = sealStreamKey({ ...key, profile: 'original' })
    expect(errorCode(await anon(`/api/v1/share/stream?key=${whole}`), 403)).toBe('share_previews_only')
  })

  it('plays whole songs only in full mode, and nothing when playback is off', async () => {
    const link = await create({ kind: 'album', id: album.albumId })
    const token = tokenOf(link)
    const trackId = album.tracks[0]!.recordingId
    try {
      await settings({ sharePlayback: 'full' })
      expect((await page(token)).playback).toBe('full')
      const song = await anon(`/api/v1/share/${token}/tracks/${trackId}/playback?codecs=flac,mp3,aac`).then((response) => body(response, ShareTrackPlayback))
      // The whole song, at the app's high quality.
      expect(song).toMatchObject({ preview: false, mime: 'audio/aac', durationMs: 34_000 })
      const whole = await anon(song.url)
      expect(whole.statusCode).toBe(200)
      expect(whole.headers['content-type']).toBe('audio/aac')
      const out = path.join(root, 'whole.aac')
      await writeFile(out, whole.rawPayload)
      expect(await decodedSeconds(out)).toBeGreaterThan(33)

      // Back to previews: the whole-song URL handed out stops working.
      await settings({ sharePlayback: 'previews' })
      expect(errorCode(await anon(song.url), 403)).toBe('share_previews_only')

      await settings({ sharePlayback: 'off' })
      expect((await page(token)).playback).toBe('off')
      expect(errorCode(await anon(`/api/v1/share/${token}/tracks/${trackId}/playback`), 403)).toBe('share_playback_off')
      expect(errorCode(await anon(song.url), 403)).toBe('share_playback_off')
    } finally {
      await settings({ sharePlayback: 'previews' })
    }
  })

  it('stops URLs already handed out when the link is revoked', async () => {
    const link = await create({ kind: 'album', id: album.albumId })
    const song = await playback(tokenOf(link), album.tracks[0]!.recordingId)
    expect((await anon(song.url, { method: 'HEAD' })).statusCode).toBe(200)
    await call({ method: 'DELETE', url: `/api/v1/me/shares/${link.id}`, headers: member.headers })
    expect(errorCode(await anon(song.url), 404)).toBe('share_not_found')
  })

  it('lets users revoke only their own links, and admins see and revoke all', async () => {
    const link = await create({ kind: 'album', id: album.albumId })
    expect(errorCode(await call({ method: 'DELETE', url: `/api/v1/me/shares/${link.id}`, headers: other.headers }), 404)).toBe('share_link_not_found')
    expect((await call({ url: '/api/v1/admin/shares', headers: member.headers })).statusCode).toBe(403)
    const all = body(await call({ url: '/api/v1/admin/shares?limit=200', headers: admin }), ShareLinkPage)
    expect(all.items.find((item) => item.id === link.id)).toMatchObject({ createdBy: { id: member.id, username: 'mira' }, title: 'Blue Hour' })
    expect((await call({ method: 'DELETE', url: `/api/v1/admin/shares/${link.id}`, headers: admin })).statusCode).toBe(200)
    expect(errorCode(await anon(link.url!.replace('/s/', '/api/v1/share/')), 404)).toBe('share_not_found')
    expect(errorCode(await call({ method: 'DELETE', url: `/api/v1/admin/shares/${link.id}`, headers: admin }), 404)).toBe('share_link_not_found')
  })

  it('pages the lists newest first', async () => {
    const user = await signIn()
    const made = [] as string[]
    for (let index = 0; index < 3; index += 1) made.push((await create({ kind: 'album', id: album.albumId }, user.headers)).id)
    const first = body(await call({ url: '/api/v1/me/shares?limit=2', headers: user.headers }), ShareLinkPage)
    const second = body(await call({ url: `/api/v1/me/shares?limit=2&cursor=${first.nextCursor}`, headers: user.headers }), ShareLinkPage)
    expect([...first.items, ...second.items].map((item) => item.id)).toEqual(made.reverse())
    expect(second.nextCursor).toBeNull()
  })

  it('limits how many links one account holds', async () => {
    const user = await signIn()
    await db.insert(shares).values(Array.from({ length: SHARE_LIMIT }, () => ({
      id: newId(), tokenHash: hashToken(newId()), userId: user.id, kind: 'album' as const, albumId: album.albumId,
    })))
    expect(errorCode(await call({ method: 'POST', url: '/api/v1/me/shares', headers: user.headers, payload: { kind: 'album', id: album.albumId } }), 409)).toBe('too_many_shares')
  })

  it('rate limits the public routes per address', async () => {
    const link = await create({ kind: 'album', id: album.albumId })
    const from = { remoteAddress: '203.0.113.77' }
    const statuses: number[] = []
    for (let index = 0; index <= SHARE_RATE_LIMITS.page; index += 1) {
      statuses.push((await app.inject({ url: `/api/v1/share/${tokenOf(link)}`, ...from })).statusCode)
    }
    expect(statuses.slice(0, SHARE_RATE_LIMITS.page).every((status) => status === 200)).toBe(true)
    const limited = await app.inject({ url: `/api/v1/share/${tokenOf(link)}`, ...from })
    expect(errorCode(limited, 429)).toBe('rate_limited')
    expect(limited.headers['retry-after']).toBeDefined()
    // Unknown tokens count too, so guessing is limited the same way.
    expect((await app.inject({ url: `/api/v1/share/${'B'.repeat(43)}`, ...from })).statusCode).toBe(429)
    // Another address is not affected.
    expect((await anon(`/api/v1/share/${tokenOf(link)}`)).statusCode).toBe(200)
  })

  it('sweeps links long expired and previews nobody played', async () => {
    const old = await create({ kind: 'album', id: album.albumId, expiresIn: '1d' })
    const recent = await create({ kind: 'album', id: album.albumId, expiresIn: '1d' })
    await db.update(shares).set({ expiresAt: new Date(Date.now() - EXPIRED_KEPT_MS - 60_000) }).where(eq(shares.id, old.id))
    await db.update(shares).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(shares.id, recent.id))

    const [file] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, album.tracks[0]!.fileId!))
    const preview = previewPath(file!)
    // Made by the preview test, or now.
    await anon((await playback(tokenOf(await create({ kind: 'album', id: album.albumId })), album.tracks[0]!.recordingId)).url)
    const longAgo = new Date(Date.now() - PREVIEW_KEPT_MS - 60_000)
    await utimes(preview, longAgo, longAgo)

    await sweepShares()
    const left = new Set((await db.select({ id: shares.id }).from(shares)).map((row) => row.id))
    expect(left.has(old.id)).toBe(false)
    expect(left.has(recent.id)).toBe(true)
    await expect(stat(preview)).rejects.toThrow()
  })
})
