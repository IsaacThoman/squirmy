import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, ErrorMessage } from './ErrorBoundary'

function Broken({ error }: { error: Error }): never {
  throw error
}

afterEach(() => vi.restoreAllMocks())

describe('a part of the app that failed', () => {
  it('stands for the page: its heading is the page title, and the tab says it did not load', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    document.title = 'Low Tide · Lune Park'
    render(<ErrorBoundary><Broken error={new TypeError('Failed to fetch dynamically imported module: /assets/imports.js')} /></ErrorBoundary>)
    expect(screen.getByRole('heading', { level: 1, name: 'This part of Squirmy could not be loaded' })).toBeInTheDocument()
    expect(document.title).toBe('Page did not load · Squirmy')
  })

  it('keeps a lower heading inside something with a title of its own', () => {
    render(<ErrorMessage error={new Error('boom')} onRetry={() => {}} />)
    expect(screen.getByRole('heading', { level: 3, name: 'Something went wrong' })).toBeInTheDocument()
  })
})
