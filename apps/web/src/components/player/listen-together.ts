import type { JamResult } from '@squirmy/client-core'
import { createContext, useContext, useState } from 'react'
import { useNavigate } from 'react-router'
import { usePlayer } from '@/player/player-context'

/** Opens the Listen together dialog from anywhere under `ListenTogetherProvider`. */
export const JamDialogContext = createContext<(() => void) | null>(null)

/** Null outside the provider (a fixture rendering the player alone), where nothing offers it. */
export function useOpenJam(): (() => void) | null {
  return useContext(JamDialogContext)
}

/** The address an invite link opens: the join page, which asks before it joins. */
export function jamLink(jamId: string): string {
  return `${window.location.origin}/jam/${encodeURIComponent(jamId)}`
}

/** What a refused jam request says. */
export function jamError(result: Extract<JamResult, { ok: false }>): string {
  switch (result.error) {
    case 'offline': return 'Can’t do that while offline.'
    case 'jam_not_found': return 'That listening session has ended.'
    case 'jam_full': return 'That listening session is full.'
    case 'jam_hosting': return 'End your own listening session first.'
    case 'jam_detached': return 'This tab plays separately. Rejoin your other devices first.'
    case 'jam_host_only': return 'Only the host can do that.'
    default: return 'Something went wrong. Try again.'
  }
}

/** The join page's answer: what the link is to, and joining it. */
export function useJoinJam(jamId: string) {
  const player = usePlayer()
  const navigate = useNavigate()
  const open = useOpenJam()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const join = async () => {
    setPending(true)
    const result = await player.controls.jam({ action: 'join', jamId })
    setPending(false)
    if (!result.ok) return setError(jamError(result))
    void navigate('/')
    open?.()
  }
  return { join, error, pending, joined: player.state.jam?.id === jamId, canJam: player.state.canJam }
}
