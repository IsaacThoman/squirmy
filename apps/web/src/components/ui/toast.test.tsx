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

  it('answers each toast’s id, the one showing for a repeat, so a caller can take it back', async () => {
    render(<Toaster />)
    let first = 0
    act(() => { first = toast({ title: 'Saved to your library', description: 'Blue Hour' }) })
    expect(toast({ title: 'Saved to your library', description: 'Blue Hour' })).toBe(first)
    await screen.findByText('Saved to your library')
    act(() => dismissToast(first))
    await waitFor(() => expect(screen.queryByText('Saved to your library')).toBeNull())
  })

  it('dismisses the toast with Escape when no dialog is open', async () => {
    render(<Toaster />)
    act(() => toast({ title: 'Added to queue' }))
    await screen.findByText('Added to queue')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(toastStore.getSnapshot()).toHaveLength(0))
  })

  it('replaces a toast with the same key in place', async () => {
    render(<Toaster />)
    act(() => toast({ key: 'run', title: 'Skipped “Intro” — not available' }))
    act(() => toast({ title: 'Added to queue' }))
    act(() => toast({ key: 'run', title: 'Skipped 2 songs — not available' }))
    expect(await screen.findByText('Skipped 2 songs — not available')).toBeInTheDocument()
    expect(screen.queryByText('Skipped “Intro” — not available')).toBeNull()
    expect(toastStore.getSnapshot().map(item => [item.title, item.revision ?? 0])).toEqual([['Skipped 2 songs — not available', 1], ['Added to queue', 0]])
  })
})
