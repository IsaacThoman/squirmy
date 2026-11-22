import { describe, expect, it } from 'vitest'
import { contextLabel, searchContext } from './context.js'

describe('contextLabel', () => {
  it('names the kind of collection over its name', () => {
    expect(contextLabel({ type: 'album', id: 'a', title: 'Dummy' })).toEqual({ heading: 'Playing from album', title: 'Dummy' })
    expect(contextLabel({ type: 'radio', id: 'track:t', title: 'Roads' })).toEqual({ heading: 'Playing from radio', title: 'Roads' })
  })

  it('quotes the query of a search, and says nothing of a search without one', () => {
    expect(contextLabel(searchContext('  arca '))).toEqual({ heading: 'Playing from search', title: '“arca”' })
    expect(contextLabel(searchContext(''))).toBeNull()
  })

  it('names the user\'s own lists when they have no title, and leaves out unnamed contexts', () => {
    expect(contextLabel({ type: 'liked', id: null, title: null })).toEqual({ heading: 'Playing from', title: 'Liked Songs' })
    expect(contextLabel({ type: 'other', id: null, title: null })).toBeNull()
    expect(contextLabel({ type: 'album', id: 'a', title: ' ' })).toBeNull()
    expect(contextLabel(null)).toBeNull()
  })
})
