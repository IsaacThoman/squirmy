import { QueryClientProvider } from '@tanstack/react-query'
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { ServicesContext } from '@/api/services'
import { fakeServices } from '@/test/fake-services'
import { RealtimeProvider, STALE_AFTER_MS } from './RealtimeProvider'

function mount() {
  const { services, socket } = fakeServices()
  const connect = vi.spyOn(socket, 'connect')
  const disconnect = vi.spyOn(socket, 'disconnect')
  const view = render(
    <ServicesContext value={services}>
      <QueryClientProvider client={createQueryClient()}>
        <RealtimeProvider><span /></RealtimeProvider>
      </QueryClientProvider>
    </ServicesContext>,
  )
  connect.mockClear()
  return { socket, connect, disconnect, view }
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** A `pageshow` from the back/forward cache, or a fresh load. jsdom has no PageTransitionEvent. */
function pageShow(persisted: boolean) {
  window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }))
}

describe('the realtime socket follows the page', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setVisibility('visible')
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes when the page goes away, so the tab leaves the device list at once, and opens again when it comes back', () => {
    const { socket, connect } = mount()
    expect(socket.connected).toBe(true)
    act(() => void window.dispatchEvent(new Event('pagehide')))
    expect(socket.connected).toBe(false)
    act(() => pageShow(true))
    expect(connect).toHaveBeenCalledTimes(1)
    expect(socket.connected).toBe(true)
  })

  it('closes while the browser freezes the page, and opens when it resumes', () => {
    const { socket, connect } = mount()
    act(() => void document.dispatchEvent(new Event('freeze')))
    expect(socket.connected).toBe(false)
    act(() => void document.dispatchEvent(new Event('resume')))
    expect(connect).toHaveBeenCalledTimes(1)
    expect(socket.connected).toBe(true)
  })

  it('leaves a merely hidden tab connected: it still answers the server', () => {
    const { socket, disconnect } = mount()
    act(() => setVisibility('hidden'))
    act(() => void vi.advanceTimersByTime(STALE_AFTER_MS * 4))
    expect(socket.connected).toBe(true)
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('renews a socket that heard no ping for too long, as after a laptop sleeps', () => {
    const { socket, connect, disconnect } = mount()
    act(() => setVisibility('hidden'))
    // Pings keep it fresh, however long the tab stays hidden.
    for (let beat = 0; beat < 10; beat += 1) {
      act(() => void vi.advanceTimersByTime(STALE_AFTER_MS / 2))
      socket.io.serverEmit('ping')
    }
    act(() => setVisibility('visible'))
    expect(disconnect).not.toHaveBeenCalled()

    act(() => setVisibility('hidden'))
    act(() => void vi.setSystemTime(Date.now() + STALE_AFTER_MS + 1))
    act(() => setVisibility('visible'))
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(socket.connected).toBe(true)
  })

  it('does not reopen on a fresh page show, which the first connect covers', () => {
    const { connect } = mount()
    act(() => pageShow(false))
    expect(connect).not.toHaveBeenCalled()
  })
})
