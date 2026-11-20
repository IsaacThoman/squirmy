import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
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
  ['/admin/library', 'Admin'],
  ['/admin/reviews', 'Admin'],
  ['/admin/organize', 'Admin'],
  ['/admin/users', 'Admin'],
  ['/admin/providers', 'Admin'],
  ['/admin/settings', 'Admin'],
  ['/admin/jobs', 'Admin'],
  ['/dev/kitchen-sink', 'Kitchen sink'],
  ['/setup', 'Welcome to Squirmy'],
  ['/login', 'Sign in to Squirmy'],
  ['/register?invite=ABC', 'Join Squirmy'],
  ['/nowhere', 'Nothing here'],
]

describe('pages', () => {
  it.each(routes)('%s renders', async (route, heading) => {
    renderWithApp(<AppRoutes />, route)
    expect(await screen.findByRole('heading', { level: heading === 'Nothing here' ? 3 : 1, name: heading })).toBeInTheDocument()
  })
})
