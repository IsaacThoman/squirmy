import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

// Pages are loaded lazily, and the first import of a large one can take longer than the
// default second on a busy machine. Stay under the 5 s test timeout so a real miss still
// reports which element was not found.
configure({ asyncUtilTimeout: 4000 })

// Node 25 and later have a localStorage of their own, which is off without a file to keep it in
// and hides jsdom's. Tests get jsdom's, as they do on older Nodes.
Object.defineProperty(globalThis, 'localStorage', {
  value: (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window.localStorage,
  configurable: true,
  writable: true,
})

// jsdom lacks the layout APIs Radix and the virtualizer reach for.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView ??= function scrollIntoView() {}
Element.prototype.scrollTo ??= function scrollTo() {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
window.matchMedia ??= (query: string) => ({
  matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
}) as MediaQueryList
Element.prototype.setPointerCapture ??= () => {}
// jsdom has no PointerEvent; without it pointer events lose their coordinates.
globalThis.PointerEvent ??= class PointerEvent extends MouseEvent {
  pointerId: number
  pointerType: string
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
    this.pointerType = init.pointerType ?? ''
  }
} as unknown as typeof globalThis.PointerEvent
// jsdom has no media playback; these would otherwise log "not implemented".
HTMLMediaElement.prototype.load = function load() {}
HTMLMediaElement.prototype.pause = function pause() {}
HTMLMediaElement.prototype.play = function play() { return Promise.resolve() }
