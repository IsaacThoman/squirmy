import { act, render } from '@testing-library/react'
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router'
import { describe, expect, it } from 'vitest'
import { useScrollMemory } from './scroll-memory'

/** A scrolling element whose `scrollTo` moves it, as a browser's does. */
function scroller() {
  const element = document.createElement('div')
  let top = 0
  Object.defineProperty(element, 'scrollTop', { get: () => top, set: (value: number) => { top = value } })
  element.scrollTo = ((options: ScrollToOptions) => { top = options.top ?? top }) as typeof element.scrollTo
  const scrollBy = (value: number) => {
    top = value
    element.dispatchEvent(new Event('scroll'))
  }
  return { element, scrollBy }
}

function setUp() {
  const main = scroller()
  const router: { navigate?: NavigateFunction } = {}
  function Shell() {
    router.navigate = useNavigate()
    useScrollMemory(main.element)
    return null
  }
  render(<MemoryRouter initialEntries={['/search?q=blue']}><Shell /></MemoryRouter>)
  const go = (to: string | number, options?: { replace: boolean }) => act(() => void (typeof to === 'number' ? router.navigate!(to) : router.navigate!(to, options)))
  return { main, go }
}

describe('useScrollMemory', () => {
  it('starts a new page at the top and returns to where Back leads', async () => {
    const { main, go } = setUp()
    main.scrollBy(640)
    await go('/album/1')
    expect(main.element.scrollTop).toBe(0)
    main.scrollBy(90)
    await go(-1)
    expect(main.element.scrollTop).toBe(640)
    await go(1)
    expect(main.element.scrollTop).toBe(90)
  })

  it('stays put when the address changes on the same page', async () => {
    const { main, go } = setUp()
    main.scrollBy(300)
    await go('/search?q=blue%20hour', { replace: true })
    expect(main.element.scrollTop).toBe(300)
  })
})
