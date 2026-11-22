import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AppearanceSettings } from './AppearanceSettings'
import { startAppearance } from './preferences'

let stop: (() => void) | undefined

beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  })
})

afterEach(() => {
  cleanup()
  stop?.()
  window.localStorage.removeItem('squirmy-appearance')
  startAppearance()()
  vi.unstubAllGlobals()
})

it('defaults to Squirmy and restores the selected mode and theme when the app restarts', async () => {
  const user = userEvent.setup()
  stop = startAppearance()
  render(<AppearanceSettings />)
  expect(screen.getByRole('radio', { name: 'Squirmy' })).toBeChecked()
  expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()

  await user.click(screen.getByRole('radio', { name: 'Pulpo' }))
  await user.click(screen.getByRole('radio', { name: 'Dark' }))
  expect(document.documentElement).toHaveAttribute('data-color-theme', 'pulpo')
  expect(document.documentElement).toHaveAttribute('data-color-mode', 'dark')

  cleanup()
  stop()
  stop = startAppearance()
  render(<AppearanceSettings />)
  expect(screen.getByRole('radio', { name: 'Pulpo' })).toBeChecked()
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
})

it('falls back to the default when the saved appearance is invalid', () => {
  window.localStorage.setItem('squirmy-appearance', '{"palette":"unknown","mode":"other"}')
  stop = startAppearance()
  render(<AppearanceSettings />)
  expect(screen.getByRole('radio', { name: 'Squirmy' })).toBeChecked()
  expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()
})
