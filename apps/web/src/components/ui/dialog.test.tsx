import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithApp } from '@/test/render'
import { Button } from './button'
import { Dialog, DialogContent } from './dialog'
import { Input } from './input'
import { DropdownMenu } from './menu'

describe('DialogContent', () => {
  it('keeps the focused field in sight when the viewport gets shorter, as a phone keyboard makes it', async () => {
    renderWithApp(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent title="Change password">
          <Input aria-label="Repeat the new password" />
        </DialogContent>
      </Dialog>,
    )
    const field = screen.getByRole('textbox', { name: 'Repeat the new password' })
    field.focus()
    const reveal = vi.spyOn(field, 'scrollIntoView')
    window.dispatchEvent(new Event('resize'))
    await waitFor(() => expect(reveal).toHaveBeenCalledWith({ block: 'nearest' }))
  })

  it('leaves a field outside any dialog alone', async () => {
    renderWithApp(
      <>
        <Input aria-label="Outside" />
        <Dialog open={false} onOpenChange={() => {}}><DialogContent title="Closed"><Input aria-label="Inside" /></DialogContent></Dialog>
      </>,
    )
    const field = screen.getByRole('textbox', { name: 'Outside' })
    field.focus()
    const reveal = vi.spyOn(field, 'scrollIntoView')
    window.dispatchEvent(new Event('resize'))
    await new Promise(resolve => requestAnimationFrame(resolve))
    expect(reveal).not.toHaveBeenCalled()
  })
})

type ShortcutProps = {
  /** The host removes the dialog as it closes, as the shell does Quick Search. */
  unmountOnClose?: boolean
  /** The field takes focus as the dialog mounts, as Quick Search's does. */
  autoFocus?: boolean
  /** The dialog animates out on closing, staying in the page (and holding focus) until its animation ends. */
  animated?: boolean
}

/**
 * Gives dialogs the enter and exit animations the stylesheet gives them in a browser: Radix's
 * Presence keeps a closing dialog until the exit animation ends. jsdom has no stylesheet.
 */
function animateDialogs() {
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo)
    if (!(element instanceof HTMLElement) || element.getAttribute('role') !== 'dialog') return style
    return new Proxy(style, {
      get: (target, key) => {
        if (key === 'animationName') return element.dataset.state === 'closed' ? 'exit' : 'enter'
        const value: unknown = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  })
}

afterEach(() => vi.restoreAllMocks())

/** A dialog opened by a shortcut or a menu, not a Radix Trigger, as Quick Search and Settings are. */
function Shortcut({ unmountOnClose = false, autoFocus = false }: ShortcutProps) {
  const [open, setOpen] = useState(false)
  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Search"><Input aria-label="Query" autoFocus={autoFocus} /></DialogContent>
    </Dialog>
  )
  return (
    <>
      <Button onKeyDown={event => { if (event.key === 'k') setOpen(true) }}>Home</Button>
      <DropdownMenu trigger={<Button>Account</Button>} entries={[{ label: 'Settings', onSelect: () => setOpen(true) }]} />
      {unmountOnClose ? open && dialog : dialog}
    </>
  )
}

const closeWithEscape = async ({ animated = false } = {}) => {
  await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement))
  await userEvent.keyboard('{Escape}')
  if (animated) {
    // A frame or two pass before the animation ends, with focus still in the closing dialog.
    await new Promise(resolve => setTimeout(resolve, 50))
    const content = screen.getByRole('dialog')
    expect(content).toContainElement(document.activeElement as HTMLElement)
    fireEvent(content, Object.assign(new Event('animationend'), { animationName: 'exit' }))
  }
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

describe('Dialog without a trigger', () => {
  it.each<[string, ShortcutProps]>([
    ['closes', {}],
    ['unmounts as it closes', { unmountOnClose: true }],
    ['unmounts as it closes, its field having taken focus as it opened', { unmountOnClose: true, autoFocus: true }],
    ['animates closed', { animated: true }],
  ])('gives focus back to what had it when it %s', async (_how, props) => {
    if (props.animated) animateDialogs()
    renderWithApp(<Shortcut {...props} />)
    const home = screen.getByRole('button', { name: 'Home' })
    home.focus()
    await userEvent.keyboard('k')
    await closeWithEscape(props)
    await waitFor(() => expect(home).toHaveFocus())
  })

  it.each([['the keyboard', true], ['a click', false]])('gives focus to the menu’s button when a menu’s item opened it with %s', async (_how, keyboard) => {
    animateDialogs()
    renderWithApp(<Shortcut />)
    const account = screen.getByRole('button', { name: 'Account' })
    if (keyboard) {
      account.focus()
      await userEvent.keyboard('{Enter}')
      await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus())
      await userEvent.keyboard('{Enter}')
    } else {
      await userEvent.click(account)
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }))
    }
    await closeWithEscape({ animated: true })
    await waitFor(() => expect(account).toHaveFocus())
  })
})
