import { describe, expect, it } from 'vitest'
import { LibraryEntityType } from './userdata.js'

describe('LibraryEntityType', () => {
  it('saves albums and tracks only', () => {
    expect(LibraryEntityType.options).toEqual(['album', 'track'])
    expect(() => LibraryEntityType.parse('artist')).toThrow()
  })
})
