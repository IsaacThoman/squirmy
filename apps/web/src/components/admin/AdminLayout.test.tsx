import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithApp } from '@/test/render'
import { fitSections } from './admin-sections'
import { AdminLayout } from './AdminLayout'

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>
}

function renderAdmin(route: string) {
  return renderWithApp(
    <Routes>
      <Route path="/admin" element={<AdminLayout counts={{ '/admin/reviews': 3 }} />}>
        <Route path="*" element={<Where />} />
      </Route>
    </Routes>,
    route,
  )
}

/** Lays the header out: every section link (and More) `width` px wide, in a row `room` px wide. */
function layOut(room: number, width: number) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(room)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width } as DOMRect)
}

afterEach(() => vi.restoreAllMocks())

describe('fitting the admin sections', () => {
  const widths = [100, 100, 100, 100, 100]

  it('shows every section when they all fit, with no More', () => {
    expect(fitSections(widths, 60, 516, 0)).toEqual([0, 1, 2, 3, 4])
  })

  it('keeps the first that fit beside More', () => {
    // 100 + 4 + 100 + 4 + 60 (More) fits 300; a third would not.
    expect(fitSections(widths, 60, 300, 0)).toEqual([0, 1])
  })

  it('always shows the current section, at the end of the row', () => {
    expect(fitSections(widths, 60, 300, 4)).toEqual([0, 4])
    expect(fitSections(widths, 60, 100, 4)).toEqual([4])
  })
})

describe('admin navigation', () => {
  it('links every section while they fit', () => {
    renderAdmin('/admin/library')
    const nav = screen.getByRole('navigation', { name: 'Admin sections' })
    expect(within(nav).getAllByRole('link')).toHaveLength(8)
    expect(within(nav).queryByRole('button', { name: /More/ })).toBeNull()
  })

  it('puts the sections that do not fit under More, which opens each of them', async () => {
    layOut(400, 90)
    renderAdmin('/admin/library')
    const nav = screen.getByRole('navigation', { name: 'Admin sections' })
    const links = within(nav).getAllByRole('link')
    expect(links.map(link => link.textContent)).toEqual(['Library', 'Review queue3, 3 open', 'Organize'])
    await userEvent.click(within(nav).getByRole('button', { name: 'More' }))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Search index', 'Providers', 'Users & invites', 'Server settings', 'Jobs'])
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Jobs' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/admin/jobs')
    // The current section always shows in the row.
    expect(within(nav).getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page')
  })
})
