import { createContext, useContext } from 'react'

/** The element the main column scrolls in, for virtualized lists and scroll-aware headers. */
export const ScrollContainerContext = createContext<HTMLElement | null>(null)

export function useScrollContainer() {
  return useContext(ScrollContainerContext)
}
