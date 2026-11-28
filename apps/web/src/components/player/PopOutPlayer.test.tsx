import type { JamInfo } from '@squirmy/contracts'
import type { ReactNode } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePlayer, PlayerContext } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import { canPopOut, usePopOut } from './pop-out'
import { PopOutPlayer } from './PopOutPlayer'

/** A window to draw into, as the browser's Picture-in-Picture window would be: an iframe's. */
function pictureInPicture() {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const target = frame.contentWindow!
  const requestWindow = vi.fn(async () => target)
  Object.defineProperty(window, 'documentPictureInPicture', { configurable: true, value: { requestWindow, window: null } })
  return { target, requestWindow, frame }
}

function Harness() {
  const popOut = usePopOut()
  return (
    <>
      <button type="button" onClick={popOut.toggle}>{popOut.popped ? 'Close pop-out player' : 'Pop out player'}</button>
      {popOut.popped && <PopOutPlayer target={popOut.popped} />}
    </>
  )
}

/** The fixture session as a member of someone's jam sees it. */
function AsMember({ children }: { children: ReactNode }) {
  const player = usePlayer()
  const jam: JamInfo = { id: 'abcdefghijklmnopqrstuv', hostUserId: 'host', queuePolicy: 'everyone', startedAt: 0, role: 'member', members: [] }
  return <PlayerContext value={{ ...player, state: { ...player.state, jam } }}>{children}</PlayerContext>
}

afterEach(() => {
  Reflect.deleteProperty(window, 'documentPictureInPicture')
  document.head.querySelector('#test-theme')?.remove()
  document.documentElement.className = ''
})

describe('the pop-out player', () => {
  it('is offered only where the browser has Document Picture-in-Picture', () => {
    expect(canPopOut()).toBe(false)
    pictureInPicture()
    expect(canPopOut()).toBe(true)
  })

  it('draws the song and its controls in its own window, with the page’s styles and appearance', async () => {
    const { target, requestWindow } = pictureInPicture()
    const theme = document.createElement('style')
    theme.id = 'test-theme'
    theme.textContent = ':root { --primary: red; }'
    document.head.append(theme)
    document.documentElement.className = 'dark'
    renderWithApp(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Pop out player' }))
    expect(requestWindow).toHaveBeenCalledOnce()
    const popped = within(target.document.body)
    // The fixture session plays Night Swimming.
    expect(await popped.findByText('Night Swimming')).toBeInTheDocument()
    expect(target.document.title).toMatch(/^Night Swimming · /)
    expect(target.document.head.querySelector('style')?.textContent).toContain('--primary: red')
    expect(target.document.documentElement).toHaveClass('dark')

    // It follows a change of appearance made in the page.
    act(() => { document.documentElement.className = '' })
    await waitFor(() => expect(target.document.documentElement).not.toHaveClass('dark'))

    // Its controls are the player's.
    await userEvent.click(popped.getByRole('button', { name: 'Pause' }))
    expect(await popped.findByRole('button', { name: 'Play' })).toBeInTheDocument()
  })

  it('dims its transport for a member of someone’s jam, and Space there does nothing', async () => {
    const { target } = pictureInPicture()
    renderWithApp(<AsMember><Harness /></AsMember>)
    await userEvent.click(screen.getByRole('button', { name: 'Pop out player' }))
    const popped = within(target.document.body)
    expect(await popped.findByText('Night Swimming')).toBeInTheDocument()
    for (const name of ['Previous', 'Pause', 'Next']) expect(popped.getByRole('button', { name })).toBeDisabled()
    // Left be (not prevented), as the window's player does not take it.
    expect(fireEvent.keyDown(target.document.body, { key: ' ' })).toBe(true)
    // Its heart is the listener's own.
    expect(popped.getByRole('button', { name: /library/ })).toBeEnabled()
  })

  it('goes when the listener closes its window', async () => {
    const { target } = pictureInPicture()
    renderWithApp(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Pop out player' }))
    expect(await within(target.document.body).findByText('Night Swimming')).toBeInTheDocument()
    act(() => { fireEvent(target, new Event('pagehide')) })
    expect(await screen.findByRole('button', { name: 'Pop out player' })).toBeInTheDocument()
    expect(target.document.body).toBeEmptyDOMElement()
  })
})
