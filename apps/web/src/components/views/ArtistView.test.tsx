import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { artists } from '@/fixtures/catalog'
import { renderWithApp } from '@/test/render'

describe('artist page', () => {
  it('names each group of the discography in the plural', async () => {
    renderWithApp(<AppRoutes />, `/artist/${artists.find(item => item.name === 'Mira Vale')!.id}`)
    expect(await screen.findByRole('heading', { level: 2, name: 'Live albums' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: 'Live' })).toBeNull()
  })
})
