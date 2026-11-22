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
  ['/settings', 'Settings'],
  ['/imports', 'Add music'],
  ['/imports/00000000-0000-4000-8a00-000000000001', 'Import'],
  ['/admin/library', 'Management'],
  ['/admin/reviews', 'Management'],
  ['/admin/organize', 'Management'],
  ['/admin/search-index', 'Management'],
  ['/admin/users', 'Management'],
  ['/admin/providers', 'Management'],
  ['/admin/settings', 'Management'],
  ['/admin/jobs', 'Management'],
  ['/dev/kitchen-sink', 'Kitchen sink'],
  ['/dev/engine', 'Audio engine'],
  ['/nowhere', 'Nothing here'],
]

const signedOut: [string, string][] = [
  ['/login', 'Sign in to Squirmy'],
  ['/register?invite=ABC', 'Join Squirmy'],
]

describe('pages', () => {
  it.each(routes)('%s renders', async (route, heading) => {
    renderWithApp(<AppRoutes />, route)
    expect(await screen.findByRole('heading', { level: heading === 'Nothing here' ? 3 : 1, name: heading })).toBeInTheDocument()
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
