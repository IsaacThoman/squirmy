import type { QueueEntry } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { AUTOPLAY_EXCLUDE, AUTOPLAY_EXCLUDE_PLAYED, autoplayRequest } from './autoplay.js'

const entry = (trackId: string): QueueEntry => ({ id: `e-${trackId}`, trackId, albumId: null, durationMs: 1, state: 'ready' } as QueueEntry)
const entries = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => entry(`${prefix}${index}`))
const session = (overrides: Partial<Parameters<typeof autoplayRequest>[0]> = {}) => ({
  autoplay: true, current: entry('now'), queue: [] as QueueEntry[], history: [] as QueueEntry[], autoplayQueue: [] as QueueEntry[], ...overrides,
})

describe('autoplayRequest', () => {
  it('asks however long the queue is, seeded from the tracks just before the suggestions', () => {
    const queue = entries('q', 30)
    const request = autoplayRequest(session({ queue, history: entries('h', 5) }))
    expect(request?.seeds).toEqual(queue.slice(-10).map(item => item.trackId))
    expect(request?.exclude).toEqual(['h0', 'h1', 'h2', 'h3', 'h4', 'now', ...queue.map(item => item.trackId)])
  })

  it('reaches back into the history when the queue is short, most recent last', () => {
    const request = autoplayRequest(session({ queue: entries('q', 2), history: entries('h', 12) }))
    expect(request?.seeds).toEqual(['h5', 'h6', 'h7', 'h8', 'h9', 'h10', 'h11', 'now', 'q0', 'q1'])
  })

  it('keeps out only the end of a very long queue, and what played last', () => {
    const queue = entries('q', AUTOPLAY_EXCLUDE + 100)
    const history = entries('h', AUTOPLAY_EXCLUDE_PLAYED + 20)
    const request = autoplayRequest(session({ queue, history }))
    expect(request?.exclude).toHaveLength(AUTOPLAY_EXCLUDE_PLAYED + 1 + AUTOPLAY_EXCLUDE)
    expect(request?.exclude[0]).toBe('h20')
    expect(request?.exclude.at(-1)).toBe(queue.at(-1)!.trackId)
  })

  it('asks for nothing with autoplay off, nothing playing, or suggestions already there', () => {
    expect(autoplayRequest(session({ autoplay: false }))).toBeNull()
    expect(autoplayRequest(session({ current: null }))).toBeNull()
    expect(autoplayRequest(session({ autoplayQueue: [entry('s')] }))).toBeNull()
  })

  it('names a track once, though the queue repeats it', () => {
    expect(autoplayRequest(session({ queue: [entry('now'), entry('a'), entry('a')] }))?.exclude).toEqual(['now', 'a'])
  })
})
