import { describe, expect, it } from 'vitest'
import { ImportListQuery } from './imports.js'

describe('ImportListQuery', () => {
  it('filters by kind only when asked', () => {
    expect(ImportListQuery.parse({}).kind).toBeUndefined()
    expect(ImportListQuery.parse({ kind: 'acquisition' }).kind).toBe('acquisition')
    expect(() => ImportListQuery.parse({ kind: 'download' })).toThrow()
  })
})
