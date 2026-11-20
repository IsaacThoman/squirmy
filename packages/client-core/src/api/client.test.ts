import type { TrackSummary } from '@squirmy/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, artworkUrl, createApiClient, type FetchLike, streamUrl, type UploadLike } from './client.js'

const id = '00000000-0000-4000-8000-000000000001'
const track: TrackSummary = {
  id,
  mbid: null,
  title: 'Tone',
  artistCredit: 'Test',
  artists: [],
  durationMs: 1000,
  album: null,
  disc: null,
  position: null,
  availability: 'server',
  liked: false,
  explicit: null,
  hasLyrics: false,
}

function respond(status: number, body: unknown, statusText = '') {
  return vi.fn<FetchLike>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => (body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)),
  }))
}

describe('createApiClient', () => {
  it('sends cookies and the CSRF and client headers without a token', async () => {
    const fetch = respond(200, { ok: true })
    const api = createApiClient({ baseUrl: 'https://music.test/', fetch, client: 'web/1.0.0' })
    await api.auth.logout()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://music.test/api/v1/auth/logout')
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' })
    expect(init.headers).toMatchObject({ 'X-Squirmy-Request': '1', 'X-Squirmy-Client': 'web/1.0.0' })
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('sends a bearer token when it has one', async () => {
    const fetch = respond(200, { tracks: [track] })
    const api = createApiClient({ baseUrl: '', fetch, getToken: async () => 'secret' })
    const result = await api.catalog.trackSummaries({ tracks: [{ id, albumId: null }] })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('/api/v1/tracks/summaries')
    expect(init).toMatchObject({ credentials: 'omit', body: JSON.stringify({ tracks: [{ id, albumId: null }] }) })
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret', 'Content-Type': 'application/json' })
    expect(result.tracks[0]).toEqual(track)
  })

  it('builds query strings and skips missing values', async () => {
    const fetch = respond(200, { items: [], nextCursor: null })
    const api = createApiClient({ baseUrl: '', fetch })
    await api.catalog.albums({ sort: 'title', genre: 'Jazz & Soul', cursor: undefined, limit: 20 })
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/library/albums?sort=title&genre=Jazz%20%26%20Soul&limit=20')
  })

  it('validates responses against the contract', async () => {
    const api = createApiClient({ baseUrl: '', fetch: respond(200, { tracks: [{ id: 'nope' }] }) })
    await expect(api.catalog.trackSummaries({ tracks: [] })).rejects.toThrow()
    const loose = createApiClient({ baseUrl: '', fetch: respond(200, { tracks: [{ id: 'nope' }] }), validate: false })
    await expect(loose.catalog.trackSummaries({ tracks: [] })).resolves.toEqual({ tracks: [{ id: 'nope' }] })
  })

  it('throws ApiError with the server code and calls onUnauthorized on 401', async () => {
    const onUnauthorized = vi.fn()
    const api = createApiClient({
      baseUrl: '',
      fetch: respond(401, { error: { code: 'unauthenticated', message: 'Sign in' } }),
      onUnauthorized,
    })
    const error = await api.auth.me().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, code: 'unauthenticated', message: 'Sign in' })
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('throws ApiError for non-JSON errors and network failures', async () => {
    const api = createApiClient({ baseUrl: '', fetch: respond(502, '<html>', 'Bad Gateway') })
    await expect(api.catalog.home()).rejects.toMatchObject({ status: 502, code: 'http_502', message: 'Bad Gateway' })
    const offline = createApiClient({ baseUrl: '', fetch: async () => { throw new TypeError('Failed to fetch') } })
    await expect(offline.catalog.home()).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })

  it('encodes path segments and maps typed likes', async () => {
    const fetch = respond(200, { items: [track], nextCursor: null })
    const api = createApiClient({ baseUrl: '', fetch })
    const page = await api.userdata.likes('track', { limit: 10 })
    expect(page.items[0]!.title).toBe('Tone')
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/me/likes/track?limit=10')
    await api.userdata.unlike('album', 'a/b').catch(() => undefined)
    expect(fetch.mock.calls[1]![0]).toBe('/api/v1/me/likes/album/a%2Fb')
  })

  it('passes an abort signal through to fetch', async () => {
    const fetch = respond(200, { artists: [], albums: [], tracks: [], provider: null })
    const api = createApiClient({ baseUrl: '', fetch })
    const signal = { aborted: false }
    await api.search.library({ q: 'blue' }, { signal })
    expect(fetch.mock.calls[0]![0]).toBe('/api/v1/search/library?q=blue')
    expect(fetch.mock.calls[0]![1].signal).toBe(signal)
  })
})

describe('imports and acquisition', () => {
  it('calls the import and acquisition routes', async () => {
    const calls: [string, string, string | undefined][] = []
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      calls.push([init.method, url, init.body])
      return { ok: true, status: 200, statusText: '', text: async () => '{}' }
    })
    const api = createApiClient({ baseUrl: '', fetch, validate: false })
    await api.imports.importOptions()
    await api.imports.createImport({ label: 'Blue Hour' })
    await api.imports.commitImport(id)
    await api.imports.getImport(id)
    await api.imports.listImports({ status: 'receiving', limit: 20 })
    await api.imports.importAlbums(id)
    await api.imports.cancelImport(id)
    await api.acquisition.listAcquisitionProviders()
    await api.acquisition.createAcquisitionProvider({ name: 'Shelf', baseUrl: 'http://shelf.lan:4801', secret: 'long enough' })
    await api.acquisition.updateAcquisitionProvider(id, { enabled: false })
    await api.acquisition.deleteAcquisitionProvider(id)
    await api.acquisition.testAcquisitionProvider(id)
    await api.acquisition.getAcquisitionPolicy()
    await api.acquisition.updateAcquisitionPolicy({ deliveryBaseUrl: null })
    await api.acquisition.listAcquisitionJobs({ status: 'failed' })
    await api.acquisition.acquireTrack(id, { albumId: id })
    await api.acquisition.acquireAlbum(id)
    expect(calls).toEqual([
      ['GET', '/api/v1/imports/options', undefined],
      ['POST', '/api/v1/imports', '{"label":"Blue Hour"}'],
      ['POST', `/api/v1/imports/${id}/commit`, undefined],
      ['GET', `/api/v1/imports/${id}`, undefined],
      ['GET', '/api/v1/imports?status=receiving&limit=20', undefined],
      ['GET', `/api/v1/imports/${id}/albums`, undefined],
      ['DELETE', `/api/v1/imports/${id}`, undefined],
      ['GET', '/api/v1/admin/acquisition/providers', undefined],
      ['POST', '/api/v1/admin/acquisition/providers', '{"name":"Shelf","baseUrl":"http://shelf.lan:4801","secret":"long enough"}'],
      ['PATCH', `/api/v1/admin/acquisition/providers/${id}`, '{"enabled":false}'],
      ['DELETE', `/api/v1/admin/acquisition/providers/${id}`, undefined],
      ['POST', `/api/v1/admin/acquisition/providers/${id}/test`, undefined],
      ['GET', '/api/v1/admin/acquisition/policy', undefined],
      ['PATCH', '/api/v1/admin/acquisition/policy', '{"deliveryBaseUrl":null}'],
      ['GET', '/api/v1/admin/acquisition/jobs?status=failed', undefined],
      ['POST', `/api/v1/tracks/${id}/acquire?albumId=${id}`, undefined],
      ['POST', `/api/v1/albums/${id}/acquire`, undefined],
    ])
  })

  it('uploads files as multipart with their relative paths, reporting progress', async () => {
    const upload = vi.fn<UploadLike>(async (_url, init) => {
      init.onProgress?.({ loaded: 5, total: 10 })
      return { ok: true, status: 200, statusText: '', text: async () => JSON.stringify({ import: {}, files: [] }) }
    })
    const api = createApiClient({ baseUrl: 'https://music.test', upload, getToken: () => 'secret', validate: false })
    const progress = vi.fn()
    const signal = { aborted: false }
    await api.imports.addImportFiles(id, [
      { file: new Blob(['one']), name: '01 One.flac', relativePath: 'Album/01 One.flac' },
      { file: new Blob(['cover']), name: 'cover.jpg' },
    ], { onProgress: progress, signal })
    const [url, init] = upload.mock.calls[0]!
    expect(url).toBe(`https://music.test/api/v1/imports/${id}/files`)
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', signal })
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret', 'X-Squirmy-Request': '1' })
    expect(init.headers['Content-Type']).toBeUndefined()
    const form = init.body as FormData
    expect([...form.keys()]).toEqual(['relativePath', 'file', 'file'])
    expect(form.get('relativePath')).toBe('Album/01 One.flac')
    expect((form.getAll('file') as File[]).map(file => file.name)).toEqual(['01 One.flac', 'cover.jpg'])
    expect(progress).toHaveBeenCalledWith({ loaded: 5, total: 10 })
  })

  it('sends through XMLHttpRequest by default, and aborts it with the signal', async () => {
    const sent: FakeXhr[] = []
    class FakeXhr {
      method = ''
      url = ''
      headers: Record<string, string> = {}
      withCredentials = false
      upload = { onprogress: null as ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null }
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      onabort: (() => void) | null = null
      status = 0
      statusText = ''
      responseText = ''
      open(method: string, url: string) { Object.assign(this, { method, url }) }
      setRequestHeader(name: string, value: string) { this.headers[name] = value }
      send() { sent.push(this) }
      abort() { this.onabort?.() }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    try {
      const api = createApiClient({ baseUrl: '', validate: false })
      const progress = vi.fn()
      const done = api.imports.addImportFiles(id, [{ file: new Blob(['x']), name: 'x.flac' }], { onProgress: progress })
      await vi.waitFor(() => expect(sent).toHaveLength(1))
      const [xhr] = sent
      expect(xhr).toMatchObject({ method: 'POST', url: `/api/v1/imports/${id}/files`, withCredentials: true })
      xhr!.upload.onprogress!({ loaded: 1, total: 1, lengthComputable: true })
      Object.assign(xhr!, { status: 200, responseText: '{"files":[]}' })
      xhr!.onload!()
      await expect(done).resolves.toEqual({ files: [] })
      expect(progress).toHaveBeenCalledWith({ loaded: 1, total: 1 })

      const controller = new AbortController()
      const stopped = api.imports.addImportFiles(id, [{ file: new Blob(['x']), name: 'x.flac' }], { signal: controller.signal })
      await vi.waitFor(() => expect(sent).toHaveLength(2))
      controller.abort()
      await expect(stopped).rejects.toMatchObject({ status: 0, code: 'network_error', message: 'The upload was stopped' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports the files kept before one over the limit', async () => {
    const files = [{ path: 'a.flac', status: 'accepted', reason: null, bytes: 3 }]
    const upload = vi.fn<UploadLike>(async () => ({
      ok: false, status: 413, statusText: 'Payload Too Large',
      text: async () => JSON.stringify({ error: { code: 'file_too_large', message: 'Files may be at most 3 bytes', details: { limit: 3, files } } }),
    }))
    const api = createApiClient({ baseUrl: '', upload })
    await expect(api.imports.addImportFiles(id, [{ file: new Blob(['abc']), name: 'a.flac' }])).rejects.toMatchObject({
      status: 413, code: 'file_too_large', details: { limit: 3, files },
    })
    const offline = createApiClient({ baseUrl: '', upload: async () => { throw new Error('The upload was stopped') } })
    await expect(offline.imports.addImportFiles(id, [])).rejects.toMatchObject({ status: 0, code: 'network_error' })
  })
})

describe('artworkUrl', () => {
  it('calls the admin library, matching, organize and search index routes', async () => {
    const calls: [string, string, string | undefined][] = []
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      calls.push([init.method, url, init.body])
      return { ok: true, status: 200, statusText: '', text: async () => '{}' }
    })
    const api = createApiClient({ baseUrl: '', fetch, validate: false })
    await api.library.scanRoot(id)
    await api.matching.reviews({ status: 'open', limit: 10 })
    await api.matching.review(id)
    await api.matching.resolveReview(id, { action: 'keep_local' })
    await api.matching.candidates(id, { query: 'Radiohead - OK Computer' })
    await api.matching.rematch(id)
    await api.matching.unmatch(id)
    await api.organize.preview({ rootId: id, writeTags: true })
    await api.organize.batches({ rootId: id })
    await api.organize.batch(id)
    await api.organize.apply(id)
    await api.organize.revert(id)
    await api.catalogIndex.status()
    await api.catalogIndex.startImport({ recordingsPerArtist: 100 })
    await api.catalogIndex.cancelImport()
    await api.catalogIndex.remove()
    expect(calls).toEqual([
      ['POST', `/api/v1/admin/library/roots/${id}/scan`, undefined],
      ['GET', '/api/v1/admin/reviews?status=open&limit=10', undefined],
      ['GET', `/api/v1/admin/reviews/${id}`, undefined],
      ['POST', `/api/v1/admin/reviews/${id}/resolve`, '{"action":"keep_local"}'],
      ['GET', `/api/v1/admin/albums/${id}/candidates?query=Radiohead%20-%20OK%20Computer`, undefined],
      ['POST', `/api/v1/admin/albums/${id}/rematch`, '{}'],
      ['POST', `/api/v1/admin/albums/${id}/unmatch`, undefined],
      ['POST', '/api/v1/admin/organize/preview', `{"rootId":"${id}","writeTags":true}`],
      ['GET', `/api/v1/admin/organize/batches?rootId=${id}`, undefined],
      ['GET', `/api/v1/admin/organize/batches/${id}`, undefined],
      ['POST', `/api/v1/admin/organize/batches/${id}/apply`, undefined],
      ['POST', `/api/v1/admin/organize/batches/${id}/revert`, undefined],
      ['GET', '/api/v1/admin/catalog-index', undefined],
      ['POST', '/api/v1/admin/catalog-index/import', '{"recordingsPerArtist":100}'],
      ['DELETE', '/api/v1/admin/catalog-index/import', undefined],
      ['DELETE', '/api/v1/admin/catalog-index', undefined],
    ])
  })

  it('picks the smallest served size that is large enough', () => {
    const artwork = { id, color: null, thumbhash: null }
    expect(artworkUrl('https://music.test', artwork, 120)).toBe(`https://music.test/api/v1/art/${id}/300`)
    expect(artworkUrl('', artwork, 96)).toBe(`/api/v1/art/${id}/96`)
    expect(artworkUrl('', artwork, 5000)).toBe(`/api/v1/art/${id}/1200`)
    expect(artworkUrl('', null, 96)).toBeNull()
  })
})

describe('streamUrl', () => {
  it('resolves the signed url against the server root', () => {
    expect(streamUrl('https://music.test/', { url: '/api/v1/stream/f?sig=1' })).toBe('https://music.test/api/v1/stream/f?sig=1')
    expect(streamUrl('', { url: '/api/v1/stream/f' })).toBe('/api/v1/stream/f')
    expect(streamUrl('https://music.test', { url: 'https://cdn.test/f' })).toBe('https://cdn.test/f')
  })
})
