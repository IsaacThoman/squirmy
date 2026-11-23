/**
 * The scroll behavior for a scroll the app starts itself (a rail's arrows, synced lyrics). The
 * reduced-motion rule in `index.css` only reaches CSS; a `behavior: 'smooth'` passed from script
 * escapes it, so script asks here. Read at each scroll, so a change in the system setting applies
 * at once.
 */
export function scrollBehavior(): ScrollBehavior {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
