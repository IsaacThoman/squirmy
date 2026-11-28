import { useCallback, useState } from 'react'

/** Chromium's Document Picture-in-Picture: a small always-on-top window the page draws into. */
type DocumentPictureInPicture = {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>
  window: Window | null
}

const documentPip = (): DocumentPictureInPicture | undefined =>
  typeof window === 'undefined' ? undefined : (window as Window & { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture

/** Whether this browser can pop the player out; elsewhere nothing offers it. */
export const canPopOut = () => documentPip() !== undefined

/**
 * Keeps the window's styles the page's: its stylesheets (the bundle's, the color theme's) and the
 * class on `<html>` that says light or dark, as they change. Copied as elements, not as text, so
 * nothing is evaluated there and the server's Content-Security-Policy, which the window shares
 * with the page, allows what the page allows. Returns what stops following them.
 */
function mirrorStyles(target: Window): () => void {
  const source = document
  // Relative addresses in the stylesheets (the bundled font) resolve against the page, not about:blank.
  const base = target.document.createElement('base')
  base.href = source.baseURI
  target.document.head.append(base)
  let copies: Node[] = []
  const copy = () => {
    for (const node of copies) node.parentNode?.removeChild(node)
    copies = [...source.head.querySelectorAll('link[rel="stylesheet"], style')].map(node => target.document.importNode(node, true))
    target.document.head.append(...copies)
    target.document.documentElement.className = source.documentElement.className
    target.document.documentElement.style.colorScheme = getComputedStyle(source.documentElement).colorScheme
  }
  copy()
  const observer = new MutationObserver(copy)
  observer.observe(source.head, { childList: true, subtree: true, characterData: true })
  observer.observe(source.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

/**
 * The popped-out player's window, opened by a click (or a key: the browser asks for a gesture)
 * and gone when the listener closes it there or the page goes.
 */
export function usePopOut() {
  const [popped, setPopped] = useState<Window | null>(null)
  const open = useCallback(async () => {
    const pip = documentPip()
    if (!pip) return
    if (pip.window) return pip.window.focus()
    const opened = await pip.requestWindow({ width: 320, height: 380 })
    const stop = mirrorStyles(opened)
    opened.document.title = 'Squirmy'
    opened.addEventListener('pagehide', () => {
      stop()
      setPopped(current => (current === opened ? null : current))
    }, { once: true })
    setPopped(opened)
  }, [])
  const close = useCallback(() => popped?.close(), [popped])
  const toggle = useCallback(() => (popped ? close() : void open().catch(() => {})), [popped, open, close])
  return { popped, open, close, toggle }
}

/** Names the popped-out window after the song, as the tab is. */
export function setWindowTitle(target: Window, title: string) {
  target.document.title = title
}
