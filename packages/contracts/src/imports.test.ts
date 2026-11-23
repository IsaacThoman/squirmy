import { describe, expect, it } from 'vitest'
import { importFileKind, ImportListQuery } from './imports.js'

describe('ImportListQuery', () => {
  it('filters by kind only when asked', () => {
    expect(ImportListQuery.parse({}).kind).toBeUndefined()
    expect(ImportListQuery.parse({ kind: 'acquisition' }).kind).toBe('acquisition')
    expect(() => ImportListQuery.parse({ kind: 'download' })).toThrow()
  })
})

describe('importFileKind', () => {
  it('takes audio, album sidecars and zips by name, from a path or a bare name', () => {
    expect(['Album/01 One.FLAC', 'b.mp3', 'Album/cover.jpg', 'Folder.PNG', 'x.lrc', 'rip.log', 'Album.zip'].map(importFileKind))
      .toEqual(['audio', 'audio', 'sidecar', 'sidecar', 'sidecar', 'sidecar', 'archive'])
  })

  it('refuses anything else, and names that are only an extension', () => {
    expect(['notes.txt', 'back.jpg', 'song.flac.txt', 'noext', '.flac', 'flac.d/readme'].map(importFileKind)).toEqual([null, null, null, null, null, null])
  })
})
