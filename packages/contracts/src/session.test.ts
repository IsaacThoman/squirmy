import { describe, expect, it } from 'vitest'
import { ServerEvent } from './session.js'

describe('ServerEvent', () => {
  it('reads the playback.unavailable notice', () => {
    const event = { type: 'playback.unavailable', trackId: null }
    expect(ServerEvent.parse(event)).toEqual(event)
  })
})
