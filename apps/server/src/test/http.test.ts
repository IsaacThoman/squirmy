import { describe, expect, it } from 'vitest'
import { redactSecrets } from './http.js'

describe('recorded fixtures', () => {
  it('never keep a credential from the recorded request', () => {
    expect(redactSecrets('https://webservice.fanart.tv/v3/music/x?api_key=real-key&x=1')).toBe('https://webservice.fanart.tv/v3/music/x?api_key=REDACTED&x=1')
    expect(redactSecrets('client=abc&meta=recordings&duration=10')).toBe('client=REDACTED&meta=recordings&duration=10')
    expect(redactSecrets('method=track.scrobble&sk=session&api_sig=sig&token=t')).toBe('method=track.scrobble&sk=REDACTED&api_sig=REDACTED&token=REDACTED')
    expect(redactSecrets('https://api.deezer.com/album/12?skip=1')).toBe('https://api.deezer.com/album/12?skip=1')
  })
})
