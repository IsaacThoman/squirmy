import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resetConfig } from '../../config.js'

const calls = vi.hoisted(() => ({ albums: [] as string[], release: new Map<string, () => void>() }))
vi.mock('./album.js', () => ({
  hydrateAlbum: (id: string) => {
    calls.albums.push(id)
    return new Promise<void>((resolve) => calls.release.set(id, resolve))
  },
}))

const { ensureAlbumDetail, setDetailWarming, warmDetail } = await import('./detail.js')
const { setDetailBudget } = await import('./runner.js')

describe('warming detail', () => {
  beforeAll(() => {
    process.env.DATABASE_URL ??= 'postgres://localhost/unused'
    process.env.NODE_ENV = 'test'
    resetConfig()
    setDetailBudget(1000)
  })
  afterAll(() => setDetailWarming(false))

  it('does nothing under test unless switched on', () => {
    warmDetail('album', 'a0')
    expect(calls.albums).toEqual([])
  })

  it('starts the run a page then joins, and caps how many run at once', async () => {
    setDetailWarming(true)
    warmDetail('album', 'a1')
    warmDetail('album', 'a1')
    warmDetail('album', 'a2')
    warmDetail('album', 'a3')
    expect(calls.albums).toEqual(['a1', 'a2'])
    const page = ensureAlbumDetail('a1')
    expect(calls.albums).toEqual(['a1', 'a2'])
    calls.release.get('a1')!()
    await page
    calls.release.get('a2')!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    warmDetail('album', 'a3')
    expect(calls.albums).toEqual(['a1', 'a2', 'a3'])
    calls.release.get('a3')!()
  })
})
