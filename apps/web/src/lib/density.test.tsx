import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScrollContainerContext } from '@/components/layout/scroll-context'
import { VirtualTrackList } from '@/components/music/TrackList'
import { allTracks } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'
import { CARD_MIN_WIDTH, DENSITY_STORAGE_KEY, effectiveDensity, setDensity, startDensity, TRACK_ROW_HEIGHT } from './density'

const source = (file: string) => readFileSync(join(import.meta.dirname, file), 'utf8')
/** A Tailwind spacing class's size in px: `h-9` is 9 × 4. */
const px = (step: string) => Number(step) * 4

describe('display density', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => {
    setDensity('comfortable')
    vi.restoreAllMocks()
  })

  it('is compact only with a fine pointer', () => {
    expect(effectiveDensity('compact', true)).toBe('compact')
    expect(effectiveDensity('compact', false)).toBe('comfortable')
    expect(effectiveDensity('comfortable', true)).toBe('comfortable')
  })

  it('is kept in this browser and set on the page', () => {
    setDensity('compact')
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe('compact')
    expect(document.documentElement.dataset.density).toBe('compact')
    localStorage.setItem(DENSITY_STORAGE_KEY, 'comfortable')
    startDensity()
    expect(document.documentElement.dataset.density).toBe('comfortable')
  })

  it('draws song rows at the heights the virtualizer places them by', () => {
    // The row's own classes: `h-11`, and `compact:h-9` under the compact variant.
    const row = /grid h-(\d+) content-center items-center gap-x-3 compact:h-(\d+)/.exec(source('../components/music/TrackList.tsx'))
    expect(row && [px(row[1]!), px(row[2]!)]).toEqual([TRACK_ROW_HEIGHT.comfortable, TRACK_ROW_HEIGHT.compact])
    const grid = /minmax\((\d+)rem,1fr\)\)\] compact:sm:grid-cols-\[repeat\(auto-fill,minmax\((\d+)rem,1fr\)\)\]/.exec(source('../components/music/Cards.tsx'))
    expect(grid && [Number(grid[1]) * 16, Number(grid[2]) * 16]).toEqual([CARD_MIN_WIDTH.comfortable, CARD_MIN_WIDTH.compact])
  })

  it('places virtualized rows by the density in use', () => {
    const fine = vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
      matches: query === '(pointer: fine)', media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    }) as MediaQueryList)
    const scroller = document.createElement('div')
    const tops = () => screen.getAllByRole('listitem').slice(0, 3).map(row => row.style.transform)
    renderWithApp(<ScrollContainerContext value={scroller}><VirtualTrackList label="Songs" tracks={allTracks.slice(0, 5)} onPlay={() => {}} /></ScrollContainerContext>)
    expect(tops()).toEqual(['translateY(0px)', 'translateY(44px)', 'translateY(88px)'])
    act(() => setDensity('compact'))
    expect(tops()).toEqual(['translateY(0px)', 'translateY(36px)', 'translateY(72px)'])
    // A touch screen keeps the rows a finger needs, whatever the setting.
    fine.mockRestore()
    act(() => setDensity('comfortable'))
    act(() => setDensity('compact'))
    expect(tops()).toEqual(['translateY(0px)', 'translateY(44px)', 'translateY(88px)'])
  })
})
