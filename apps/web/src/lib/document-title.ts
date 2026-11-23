import { useEffect, useSyncExternalStore } from 'react'

/**
 * The browser tab's title. A page that has a name worth more than a paused song gives it with
 * `usePageTitle` (a missing page, one that failed to load), and the player writes the title from
 * it and the current song (`useDocumentTitle`).
 */

let pageTitle: string | null = null
const listeners = new Set<() => void>()

function setPageTitle(title: string | null) {
  if (pageTitle === title) return
  pageTitle = title
  // Outside the signed-in shell (the whole app failed) no player writes the title: it is written here.
  if (!listeners.size) document.title = documentTitle(title, null, false)
  for (const listener of [...listeners]) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Names the tab after this page while it shows. */
export function usePageTitle(title: string) {
  useEffect(() => {
    setPageTitle(title)
    return () => setPageTitle(null)
  }, [title])
}

type Song = { title: string; artistCredit: string }

/**
 * What the tab says: the song while one plays, so the tab finds the music; else the page's own
 * name, so a paused song does not hide it; else the paused song; else Squirmy.
 */
export function documentTitle(page: string | null, song: Song | null, playing: boolean): string {
  const songTitle = song && `${song.title} · ${song.artistCredit}`
  if (songTitle && playing) return songTitle
  if (page) return `${page} · Squirmy`
  return songTitle ?? 'Squirmy'
}

/** Keeps the tab's title up to date with the page and the current song. */
export function useDocumentTitle(song: Song | null, playing: boolean) {
  const page = useSyncExternalStore(subscribe, () => pageTitle)
  const title = documentTitle(page, song, playing)
  useEffect(() => {
    document.title = title
  }, [title])
}
