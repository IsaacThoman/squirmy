import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { artists } from '@/fixtures/catalog'
import { users } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

describe('artist page', () => {
  it('names each group of the discography in the plural', async () => {
    renderWithApp(<AppRoutes />, `/artist/${artists.find(item => item.name === 'Mira Vale')!.id}`)
    expect(await screen.findByRole('heading', { level: 2, name: 'Live albums' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Live' })).toBeNull()
  })
})

describe('artist page counts', () => {
  const miraVale = () => artists.find(item => item.name === 'Mira Vale')!

  it('gives a requester no count of what is on the server', async () => {
    renderWithApp(<AppRoutes />, `/artist/${miraVale().id}`)
    await screen.findByRole('heading', { level: 1, name: 'Mira Vale' })
    expect(document.body.textContent).not.toMatch(/\d+ of \d+|none in your library|available/i)
  })

  it('tells a member who may not fetch music how much plays', async () => {
    renderWithApp(<AppRoutes />, `/artist/${miraVale().id}`, fakeServices({ user: users[2] }).services)
    expect(await screen.findByText(/^\d+ of \d+ releases available$/)).toBeInTheDocument()
  })
})
