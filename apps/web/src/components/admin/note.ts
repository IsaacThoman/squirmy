import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '@/api/errors'

/** What an action says where it was started: news of what it did, or why it did not. */
export type Note = { tone: 'info' | 'error'; text: string }

/** How long news stays; a failure stays until the next try. */
export const NOTE_MS = 8000

/**
 * The note of a row or a panel, and `run`, which runs an action and sets the note from how it
 * went: the server's reason when it fails, `said(result)` when it succeeds (nothing when that is
 * null, as the change on screen is news enough). `run` answers the result, or undefined on a failure.
 */
export function useNote() {
  const [note, setNote] = useState<Note | null>(null)
  useEffect(() => {
    if (note?.tone !== 'info') return
    const timer = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(timer)
  }, [note])
  const run = useCallback(async <T,>(work: () => Promise<T>, said?: (result: T) => string | null | undefined): Promise<T | undefined> => {
    setNote(null)
    try {
      const result = await work()
      const text = said?.(result)
      if (text) setNote({ tone: 'info', text })
      return result
    } catch (error) {
      setNote({ tone: 'error', text: errorMessage(error) })
      return undefined
    }
  }, [])
  return { note, setNote, run }
}
