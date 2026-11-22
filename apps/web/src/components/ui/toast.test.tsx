import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, toast, toastStore } from '@/lib/toast'
import { Dialog, DialogContent } from './dialog'
import { Toaster } from './toast'

afterEach(() => {
  for (const item of toastStore.getSnapshot()) dismissToast(item.id)
})

describe('Toaster', () => {
  it('leaves Escape to the open dialog while a toast shows', async () => {
    const onOpenChange = vi.fn()
    render(<><Dialog open onOpenChange={onOpenChange}><DialogContent title="Settings"><input aria-label="Name" /></DialogContent></Dialog><Toaster /></>)
    act(() => toast({ title: 'Browser renamed' }))
    await screen.findByText('Browser renamed')
    await userEvent.keyboard('{Escape}')
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getByText('Browser renamed')).toBeInTheDocument()
  })

  it('dismisses the toast with Escape when no dialog is open', async () => {
    render(<Toaster />)
    act(() => toast({ title: 'Added to queue' }))
    await screen.findByText('Added to queue')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(toastStore.getSnapshot()).toHaveLength(0))
  })
})
