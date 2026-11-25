import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album, home, summary } from '@/fixtures/catalog'
import { users } from '@/fixtures/server'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { AlbumCard } from './Cards'

const blueHour = album('blue-hour')
/** A member: the album page's Fix match is for admins, and is the page's own. */
const member = users[1]!

const entries = () => screen.getAllByRole('menuitem').map(item => item.textContent)

describe('album menu', () => {
  it('is the album page’s on its cards, Play and Shuffle included', async () => {
    const { services } = fakeServices({ user: member })
    const page = renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click(await screen.findByRole('button', { name: 'More options' }))
    const onPage = entries()
    page.unmount()

    renderWithApp(<AlbumCard album={summary(blueHour)} onPlay={() => {}} />, '/', services)
    await userEvent.click(screen.getByRole('button', { name: 'More options for Blue Hour' }))
    await screen.findByRole('menuitem', { name: 'Remove from library' })
    expect(onPage.slice(0, 2)).toEqual(['Play', 'Shuffle'])
    expect(entries()).toEqual(onPage)
  })

  it('shuffles the album from a card’s Shuffle', async () => {
    const { services, socket } = fakeServices()
    renderWithApp(<AppRoutes />, '/', services)
    const added = home.sections.find(section => section.id === 'recently-added')!
    const rail = await screen.findByRole('region', { name: added.title })
    await userEvent.click(within(rail).getByRole('button', { name: 'More options for Endless Room' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Shuffle' }))
    await waitFor(() => expect(socket.session.current).not.toBeNull())
    expect(socket.session.shuffle).toBe(true)
    expect(socket.session.context).toEqual(expect.objectContaining({ type: 'album', id: album('endless-room').id }))
  })

  it('is on Home’s album rails', async () => {
    const { services, api } = fakeServices()
    renderWithApp(<AppRoutes />, '/', services)
    const added = home.sections.find(section => section.id === 'recently-added')!
    const rail = await screen.findByRole('region', { name: added.title })
    await userEvent.click(within(rail).getByRole('button', { name: 'More options for Endless Room' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Save to library' }))
    await waitFor(() => expect(api.userdata.like).toHaveBeenCalledWith('album', album('endless-room').id))
  })

  // Search lists albums as rows of one ranked list, with the row menus of `result-menus.tsx`
  // (#117), which add Go to album; this only checks one is there for an album result.
  it('leaves search’s album rows a menu of their own', async () => {
    renderWithApp(<AppRoutes />, '/search?q=blue')
    const results = await screen.findByRole('list', { name: /^Results for/ })
    await userEvent.click(await within(results).findByRole('button', { name: 'More options for Blue Hour' }))
    expect(await screen.findByRole('menuitem', { name: 'Add to playlist' })).toBeInTheDocument()
  })
})
