import { createContext, useContext } from 'react'
import type { Viewer } from '@/lib/catalog'

/**
 * Who is looking, for the rule of what plays: a file on the server plays for everyone, music
 * the server can fetch plays for a requester (an admin, or a member who may fetch). Null
 * signed out, when nothing that would need fetching looks playable.
 */
export type OnDemand = { viewer: Viewer | null }

export const OnDemandContext = createContext<OnDemand>({ viewer: null })

export function useViewer(): Viewer | null {
  return useContext(OnDemandContext).viewer
}
