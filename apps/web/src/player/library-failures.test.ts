import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAILURE_MS, LibraryFailures } from './library-context'

afterEach(() => vi.useRealTimers())

describe('LibraryFailures', () => {
  it('holds a refusal for a few seconds, for the control that made it, and the announcement with its name', () => {
    vi.useFakeTimers()
    const failures = new LibraryFailures()
    const listener = vi.fn()
    failures.subscribe(listener)
    failures.fail('save:a', 'Couldn’t save. Try again.', 'Couldn’t save “Amber” to your library. Try again.')
    expect(failures.get('save:a')).toBe('Couldn’t save. Try again.')
    expect(failures.get('want:a')).toBeNull()
    expect(failures.latest()).toBe('Couldn’t save “Amber” to your library. Try again.')
    expect(listener).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FAILURE_MS)
    expect(failures.get('save:a')).toBeNull()
    expect(failures.latest()).toBeNull()
  })

  it('lets a refusal go when the control is used again, and keeps the others', () => {
    const failures = new LibraryFailures()
    failures.fail('save:a', 'Couldn’t save. Try again.', 'a')
    failures.fail('want:b', 'Couldn’t add to your Wantlist. Try again.', 'b')
    failures.clear('save:a')
    expect(failures.get('save:a')).toBeNull()
    expect(failures.get('want:b')).toBe('Couldn’t add to your Wantlist. Try again.')
    expect(failures.latest()).toBe('b')
  })
})
