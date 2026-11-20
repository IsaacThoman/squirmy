import { useState } from 'react'

/**
 * A text field whose value lives in the URL. Navigations update the URL in a transition, so a
 * field bound to it directly falls behind fast typing and drops keys. This shows what was
 * typed until the URL has caught up with it.
 */
export function useUrlDraft(urlValue: string): [string, (text: string) => void] {
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null && draft === urlValue) setDraft(null)
  return [draft ?? urlValue, setDraft]
}
