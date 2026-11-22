import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

const routes: [string, string | RegExp][] = [
  ['/', 'Listen now'],
  ['/search', 'Search'],
  ['/search?q=soft', 'Search'],
  ['/library/albums', 'Library'],
  ['/library/artists', 'Library'],
  ['/library/songs', 'Library'],
  ['/library/playlists', 'Library'],
  ['/liked', 'Liked Songs'],
  ['/wantlist', 'Wantlist'],
  ['/album/00000000-0000-4000-8200-000000000001', 'Blue Hour'],
  ['/artist/00000000-0000-4000-8100-000000000001', 'Mira Vale'],
  ['/playlist/00000000-0000-4000-8400-000000000001', 'After Dark'],
  ['/imports', 'Add music'],
  ['/imports/00000000-0000-4000-8a00-000000000001', 'Import'],
  ['/admin/library', 'Admin'],
  ['/admin/reviews', 'Admin'],
  ['/admin/organize', 'Admin'],
  ['/admin/search-index', 'Admin'],
  ['/admin/users', 'Admin'],
  ['/admin/providers', 'Admin'],
  ['/admin/settings', 'Admin'],
  ['/admin/jobs', 'Admin'],
  ['/dev/kitchen-sink', 'Kitchen sink'],
  ['/dev/engine', 'Audio engine'],
  ['/nowhere', 'Nothing here'],
]

const LAZY_DEV_PAGE_MS = 15_000

const signedOut: [string, string][] = [
  ['/login', 'Sign in to Squirmy'],
  ['/register?invite=ABC', 'Join Squirmy'],
]

describe('pages', () => {
  it.each(routes)('%s renders', async (route, heading) => {
    renderWithApp(<AppRoutes />, route)
    // The dev pages are the largest lazy chunks, and under a full parallel run their first import can take a while.
    const wait = route.startsWith('/dev/') ? { timeout: LAZY_DEV_PAGE_MS } : undefined
    expect(await screen.findByRole('heading', { level: heading === 'Nothing here' ? 3 : 1, name: heading }, wait)).toBeInTheDocument()
  }, LAZY_DEV_PAGE_MS + 2000)

  it('/wantlist goes home while the server has the wantlist off', async () => {
    renderWithApp(<AppRoutes />, '/wantlist', fakeServices({ status: { wantlistEnabled: false } }).services)
    expect(await screen.findByRole('heading', { level: 1, name: 'Listen now' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Wantlist' })).not.toBeInTheDocument()
  })

  it.each(['/settings', '/settings/appearance'])('%s opens the settings dialog over the home page', async route => {
    renderWithApp(<AppRoutes />, route)
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
    // The dialog is modal, so the page behind it is out of reach while it is open.
    expect(await screen.findByRole('heading', { level: 1, name: 'Listen now', hidden: true })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument()
  })

  it.each(signedOut)('%s renders signed out', async (route, heading) => {
    renderWithApp(<AppRoutes />, route, fakeServices({ user: null }).services)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
  })

  it('/setup renders before the first admin exists', async () => {
    renderWithApp(<AppRoutes />, '/setup', fakeServices({ user: null, status: { needsSetup: true } }).services)
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome to Squirmy' })).toBeInTheDocument()
  })
})
