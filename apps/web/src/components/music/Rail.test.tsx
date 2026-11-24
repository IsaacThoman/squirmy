import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Rail, RailItem } from './Rail'

/** jsdom lays nothing out: every rail is 400px wide over 1,200px of cards, and scrolls as a browser's does. */
const WIDTH = 400
const CONTENT = 1200
const offsets = new WeakMap<Element, number>()

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(WIDTH)
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(CONTENT)
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: HTMLElement) { return offsets.get(this) ?? 0 },
    set(this: HTMLElement, value: number) {
      offsets.set(this, Math.max(0, Math.min(value, CONTENT - WIDTH)))
      this.dispatchEvent(new Event('scroll'))
    },
  })
  HTMLElement.prototype.scrollBy = function scrollBy(this: HTMLElement, options?: ScrollToOptions | number) {
    this.scrollLeft += typeof options === 'object' ? options.left ?? 0 : options ?? 0
  } as typeof HTMLElement.prototype.scrollBy
  // A browser measures an element as soon as it is observed.
  vi.stubGlobal('ResizeObserver', class {
    private readonly callback: () => void
    constructor(callback: () => void) { this.callback = callback }
    observe() { this.callback() }
    unobserve() {}
    disconnect() {}
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollLeft')
})

/** Each test has a rail of its own name: positions are kept for the tab, across tests too. */
function Cards({ title }: { title: string }) {
  return (
    <Rail title={title}>
      {Array.from({ length: 8 }, (_, index) => <RailItem key={index}><a href={`/album/${index}`}>Album {index}</a></RailItem>)}
    </Rail>
  )
}

function setUp(title: string) {
  const router: { navigate?: NavigateFunction } = {}
  function Navigator() {
    const navigate = useNavigate()
    useEffect(() => { router.navigate = navigate })
    return null
  }
  render(
    <MemoryRouter initialEntries={['/']}>
      <Navigator />
      <Routes>
        <Route path="/" element={<Cards title={title} />} />
        <Route path="/album/:id" element={<p>Album</p>} />
      </Routes>
    </MemoryRouter>,
  )
  const go = (to: string | number) => act(() => void (typeof to === 'number' ? router.navigate!(to) : router.navigate!(to)))
  return { go }
}

const rail = () => within(screen.getByRole('region'))
const scroller = () => screen.getByRole('region').querySelector<HTMLElement>('.overflow-x-auto')!

describe('Rail', () => {
  it('keeps keyboard focus on the forward button when it reaches the end', async () => {
    setUp('Recently played')
    const forward = rail().getByRole('button', { name: 'Scroll forward' })
    expect(rail().getByRole('button', { name: 'Scroll back' })).toHaveAttribute('aria-disabled', 'true')
    forward.focus()
    for (let press = 0; press < 3; press++) await userEvent.keyboard(' ')
    expect(scroller().scrollLeft).toBe(CONTENT - WIDTH)
    expect(forward).toHaveAttribute('aria-disabled', 'true')
    expect(forward).toHaveFocus()
    // Pressed again at the end, it does nothing.
    await userEvent.keyboard(' ')
    expect(scroller().scrollLeft).toBe(CONTENT - WIDTH)
    expect(rail().getByRole('button', { name: 'Scroll back' })).not.toHaveAttribute('aria-disabled')
  })

  it('returns to where it was left on Back, and starts at its start on a new visit', async () => {
    const { go } = setUp('Recently added')
    await userEvent.click(rail().getByRole('button', { name: 'Scroll forward' }))
    expect(scroller().scrollLeft).toBe(340)
    await go('/album/3')
    await go(-1)
    expect(scroller().scrollLeft).toBe(340)
    await go('/album/4')
    await go('/')
    expect(scroller().scrollLeft).toBe(0)
  })
})
