import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

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
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
} as unknown as typeof globalThis.PointerEvent
// jsdom has no media playback; these would otherwise log "not implemented".
HTMLMediaElement.prototype.load = function load() {}
HTMLMediaElement.prototype.pause = function pause() {}
HTMLMediaElement.prototype.play = function play() { return Promise.resolve() }
