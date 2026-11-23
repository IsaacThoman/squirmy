import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { renderWithApp } from '@/test/render'
import { Dialog, DialogContent } from './dialog'
import { Tooltip } from './tooltip'

/** A control with a tooltip, and a dialog that opens without the pointer or focus leaving it (as the wheel opens Now Playing). */
function Scene() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Tooltip label="Save to library"><button type="button">Heart</button></Tooltip>
      <button type="button" onClick={() => setOpen(true)} data-testid="open">Open</button>
      <Dialog open={open} onOpenChange={setOpen}><DialogContent title="Now Playing">Playing</DialogContent></Dialog>
    </>
  )
}

describe('Tooltip', () => {
  it('closes when a dialog opens over it', async () => {
    renderWithApp(<Scene />)
    // Hovered, not focused: the pointer stays on the heart as the layer opens over it.
    fireEvent.pointerMove(screen.getByRole('button', { name: 'Heart' }), { pointerType: 'mouse' })
    expect(await screen.findByRole('tooltip', {}, { timeout: 3000 })).toHaveTextContent('Save to library')
    act(() => { screen.getByTestId('open').click() })
    await screen.findByRole('dialog', { name: 'Now Playing' })
    // `hidden`: the modal hides the rest of the page from role queries, so look past that.
    await waitFor(() => expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull())
  })
})
