import type { TrackSummary } from '@squirmy/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, artworkUrl, createApiClient, type FetchLike, type FormDataLike, streamUrl, type XhrLike } from './client.js'
import { apiRoutes } from './routes.js'

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

  it('saves to the library and names why music is fetched', async () => {
    const fetch = respond(200, { ok: true })
    const api = createApiClient({ baseUrl: '', fetch, validate: false })
    await api.library.save('album', id)
    await api.library.remove('track', id)
    await api.acquisition.acquireAlbum(id, { origin: 'download' })
    await api.acquisition.acquireTrack(id, { albumId: id, origin: 'library' })
    await api.imports.list({ kind: 'acquisition' })
    expect(fetch.mock.calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      `PUT /api/v1/me/library/album/${id}`,
      `DELETE /api/v1/me/library/track/${id}`,
      `POST /api/v1/albums/${id}/acquire?origin=download`,
      `POST /api/v1/tracks/${id}/acquire?albumId=${id}&origin=library`,
      'GET /api/v1/imports?kind=acquisition',
    ])
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
    await api.organize.template()
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
      ['GET', '/api/v1/admin/organize/template', undefined],
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

describe('the route manifest', () => {
  type Method = (...args: unknown[]) => Promise<unknown>
  const methodsOf = (api: ReturnType<typeof createApiClient>) => Object.entries(api).flatMap(([group, methods]) =>
    Object.entries(methods as Record<string, Method>).map(([name, method]) => [`${group}.${name}`, method] as const))

  it('lists every method of the client, and nothing else', () => {
    const names = methodsOf(createApiClient({ baseUrl: '' })).map(([name]) => name)
    expect(names.sort()).toEqual(Object.keys(apiRoutes).sort())
  })

  it('names the route each method calls', async () => {
    const calls: string[] = []
    const fetch = vi.fn<FetchLike>(async (url, init) => {
      calls.push(`${init.method} ${url.split('?')[0]}`)
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' }
    })
    const xhr = (): XhrLike => {
      const request: XhrLike = {
        open: (method, url) => calls.push(`${method} ${url}`), setRequestHeader: () => {}, withCredentials: false, upload: { onprogress: null },
        onload: null, onerror: null, onabort: null, status: 200, statusText: 'OK', responseText: '{}', send: () => request.onload?.(), abort: () => {},
      }
      return request
    }
    const api = createApiClient({ baseUrl: '', fetch, validate: false, xhr, formData: () => ({ append: () => {} }) })
    for (const [name, method] of methodsOf(api)) {
      calls.length = 0
      // Every path parameter becomes "p", and bodies and queries are left out.
      await method('p', 'p')
      const [verb, pattern] = apiRoutes[name as keyof typeof apiRoutes].split(' ') as [string, string]
      expect(calls, name).toEqual([`${verb} /api/v1${pattern.replace(/:\w+/g, 'p')}`])
    }
  })
})

describe('uploads', () => {
  function fakeXhr(answer: { status: number; body: unknown }) {
    const sent: { url?: string; method?: string; headers: Record<string, string>; body?: unknown; withCredentials?: boolean } = { headers: {} }
    const request: XhrLike = {
      open: (method, url) => Object.assign(sent, { method, url }),
      setRequestHeader: (name, value) => { sent.headers[name] = value },
      withCredentials: false,
      upload: { onprogress: null },
      onload: null, onerror: null, onabort: null,
      status: 0, statusText: '', responseText: '',
      send: (body) => {
        sent.body = body
        sent.withCredentials = request.withCredentials
        request.upload.onprogress?.({ loaded: 50, total: 100, lengthComputable: true })
        request.upload.onprogress?.({ loaded: 100, total: 0, lengthComputable: false })
        Object.assign(request, { status: answer.status, responseText: JSON.stringify(answer.body) })
        request.onload?.()
      },
      abort: () => request.onabort?.(),
    }
    return { request, sent }
  }
  const form = () => {
    const parts: [string, unknown, string | undefined][] = []
    const data: FormDataLike = { append: (name, value, filename) => parts.push([name, value, filename]) }
    return { data, parts }
  }

  it('posts each file after its relative path, with the token, and reports progress', async () => {
    const response = { import: { id }, files: [{ path: 'Album/01.flac', status: 'accepted', reason: null, bytes: 3 }] }
    const { request, sent } = fakeXhr({ status: 200, body: response })
    const { data, parts } = form()
    const api = createApiClient({ baseUrl: 'https://music.test', getToken: () => 'secret', validate: false, xhr: () => request, formData: () => data })
    const progress: unknown[] = []
    const result = await api.imports.addFiles(id, [{ data: 'bytes-1', name: '01.flac', relativePath: 'Album/01.flac' }, { data: 'bytes-2', name: 'cover.jpg' }], {
      onProgress: (update) => progress.push(update),
    })
    expect(result).toEqual(response)
    expect(sent).toMatchObject({ method: 'POST', url: `https://music.test/api/v1/imports/${id}/files`, body: data, withCredentials: false })
    expect(sent.headers).toMatchObject({ Authorization: 'Bearer secret', 'X-Squirmy-Request': '1' })
    expect(sent.headers['Content-Type']).toBeUndefined()
    expect(parts).toEqual([['relativePath', 'Album/01.flac', undefined], ['file', 'bytes-1', '01.flac'], ['file', 'bytes-2', 'cover.jpg']])
    expect(progress).toEqual([{ loaded: 50, total: 100 }, { loaded: 100, total: null }])
  })

  it('sends cookies without a token, and fails like any request', async () => {
    const { request, sent } = fakeXhr({ status: 413, body: { error: { code: 'file_too_large', message: 'Too large', details: { files: [] } } } })
    const api = createApiClient({ baseUrl: '', xhr: () => request, formData: () => form().data })
    await expect(api.imports.addFiles(id, [{ data: 'x', name: 'big.flac' }])).rejects.toMatchObject({ status: 413, code: 'file_too_large', details: { files: [] } })
    expect(sent.withCredentials).toBe(true)
  })

  it('cancels with the signal, and needs XMLHttpRequest', async () => {
    const { request } = fakeXhr({ status: 200, body: {} })
    request.send = () => {}
    let abort = () => {}
    const signal = { aborted: false, addEventListener: (_type: 'abort', listener: () => void) => { abort = listener } }
    const api = createApiClient({ baseUrl: '', xhr: () => request, formData: () => form().data })
    const pending = api.imports.addFiles(id, [{ data: 'x', name: 'a.flac' }], { signal })
    await Promise.resolve()
    await Promise.resolve()
    abort()
    await expect(pending).rejects.toMatchObject({ status: 0, code: 'aborted' })
    await expect(createApiClient({ baseUrl: '' }).imports.addFiles(id, [])).rejects.toMatchObject({ code: 'upload_unavailable' })
  })
})

describe('streamUrl', () => {
  it('resolves the signed url against the server root', () => {
    expect(streamUrl('https://music.test/', { url: '/api/v1/stream/f?sig=1' })).toBe('https://music.test/api/v1/stream/f?sig=1')
    expect(streamUrl('', { url: '/api/v1/stream/f' })).toBe('/api/v1/stream/f')
    expect(streamUrl('https://music.test', { url: 'https://cdn.test/f' })).toBe('https://cdn.test/f')
  })
})
