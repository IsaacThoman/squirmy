import { describe, expect, it } from 'vitest'
import { redactUrl } from './log.js'

describe('redactUrl', () => {
  it('hides credential parameters and keeps the rest', () => {
    expect(redactUrl('/rest/ping.view?u=mira&p=enc:736563726574&v=1.16.1&c=app')).toBe('/rest/ping.view?u=mira&p=[redacted]&v=1.16.1&c=app')
    expect(redactUrl('/rest/stream?u=mira&t=abc&s=salt&id=tr-1')).toBe('/rest/stream?u=mira&t=[redacted]&s=[redacted]&id=tr-1')
    expect(redactUrl('/rest/ping?apiKey=secret&APIKEY=again')).toBe('/rest/ping?apiKey=[redacted]&APIKEY=[redacted]')
    expect(redactUrl('/api/v1/stream/abc?exp=1&uid=u&sig=signature')).toBe('/api/v1/stream/abc?exp=1&uid=u&sig=[redacted]')
    expect(redactUrl('/api/v1/scrobble/lastfm/callback?state=a.b.c&token=tok')).toBe('/api/v1/scrobble/lastfm/callback?state=[redacted]&token=[redacted]')
    // An encoded key is still the same parameter to the server.
    expect(redactUrl('/rest/ping?%70=secret&u=a')).toBe('/rest/ping?%70=[redacted]&u=a')
    expect(redactUrl('/api/v1/tracks')).toBe('/api/v1/tracks')
  })
})
