/** The desktop sidebar's folded rail; the open sidebar is as wide as the user drags it. */
export const SIDEBAR_COLLAPSED_WIDTH = 52
export const DEFAULT_SIDEBAR_WIDTH = 264
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 385
/** Dragging the edge in past this folds the sidebar to its rail; dragging the rail out past it opens it. */
export const SIDEBAR_SNAP_WIDTH = (SIDEBAR_COLLAPSED_WIDTH + SIDEBAR_MIN_WIDTH) / 2
/** The main view is never squeezed narrower than this by the sidebar. */
const MAIN_VIEW_MIN_WIDTH = 480
/** Below this the sidebar is a drawer over the page. Matches Tailwind's `md`. */
export const MOBILE_QUERY = '(width < 768px)'

const WIDTH_KEY = 'squirmy.sidebar.width'
const COLLAPSED_KEY = 'squirmy.sidebar.collapsed'

/** The widest the open sidebar may be in this frame: it always leaves the main view its minimum. */
export function sidebarMaxWidth(frameWidth: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, frameWidth - MAIN_VIEW_MIN_WIDTH))
}

export function clampSidebarWidth(width: number, frameWidth: number): number {
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), sidebarMaxWidth(frameWidth)))
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // The preference is optional.
  }
}

export function readSidebarWidth(): number {
  const saved = Number(read(WIDTH_KEY))
  return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_SIDEBAR_WIDTH
}

export function writeSidebarWidth(width: number) {
  write(WIDTH_KEY, String(Math.round(width)))
}

export function readSidebarCollapsed(): boolean {
  return read(COLLAPSED_KEY) === '1'
}

export function writeSidebarCollapsed(collapsed: boolean) {
  write(COLLAPSED_KEY, collapsed ? '1' : '0')
}

/** Sizes the open sidebar through `--sidebar-width`, so a drag restyles it without rendering the app. */
export function applySidebarWidth(width: number) {
  document.documentElement.style.setProperty('--sidebar-width', `${width}px`)
}
