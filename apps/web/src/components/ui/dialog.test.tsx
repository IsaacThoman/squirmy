import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithApp } from '@/test/render'
import { Button } from './button'
import { Dialog, DialogContent } from './dialog'
import { Input } from './input'

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

/** A dialog opened by a shortcut, not a Radix Trigger, as Quick Search and Settings are. */
function Shortcut({ unmountOnClose = false }: { unmountOnClose?: boolean }) {
  const [open, setOpen] = useState(false)
  const dialog = (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Search"><Input aria-label="Query" /></DialogContent>
    </Dialog>
  )
  return (
    <>
      <Button onKeyDown={event => { if (event.key === 'k') setOpen(true) }}>Home</Button>
      {unmountOnClose ? open && dialog : dialog}
    </>
  )
}

describe('Dialog without a trigger', () => {
  it.each([['closes', false], ['unmounts as it closes', true]])('gives focus back to what had it when it %s', async (_how, unmountOnClose) => {
    renderWithApp(<Shortcut unmountOnClose={unmountOnClose} />)
    const home = screen.getByRole('button', { name: 'Home' })
    home.focus()
    await userEvent.keyboard('k')
    await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(home).toHaveFocus())
  })
})
