import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { matchPath, useLocation, useNavigate, useNavigationType } from 'react-router'

function pageLabel(pathname: string): string | undefined {
  switch (pathname.split('/')[1]) {
    case '': return 'Home'
    case 'search': return 'Search'
    case 'library': return 'Library'
    case 'liked': return 'Liked Songs'
    case 'wantlist': return 'Wantlist'
    case 'album': return 'album'
    case 'artist': return matchPath('/artist/:id/releases/:section', pathname) ? 'releases' : 'artist'
    case 'playlist': return 'playlist'
  }
}

/**
 * Keep the source of each history entry so the breadcrumb can go back through the router.
 * A POP restores the original entry and its scroll position, including a search's query and filters.
 */
export function BackBreadcrumb() {
  const { key, pathname } = useLocation()
  const type = useNavigationType()
  const navigate = useNavigate()
  const [history, setHistory] = useState(() => ({ key, pathname, sources: new Map<string, string>() }))
  if (key !== history.key) {
    const sources = new Map(history.sources)
    if (type === 'PUSH') {
      sources.set(key, history.pathname)
    } else if (type === 'REPLACE') {
      const source = sources.get(history.key)
      sources.delete(history.key)
      if (source !== undefined) sources.set(key, source)
    }
    if (sources.size > 100) sources.delete(sources.keys().next().value!)
    setHistory({ key, pathname, sources })
  }

  const source = history.sources.get(key)
  const label = source && source !== pathname ? pageLabel(source) : undefined
  const detail = ['/album/:id', '/artist/:id', '/playlist/:id'].some(pattern => matchPath(pattern, pathname))
  if (!detail || !label) return null

  return (
    <nav aria-label="Back navigation" className="flex min-h-10 items-center px-(--gutter) pt-1 max-md:pl-12">
      <button type="button" onClick={() => void navigate(-1)} className="-ml-1 inline-flex min-h-8 items-center gap-1 rounded-md pr-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronLeft aria-hidden className="size-4" />Back to {label}
      </button>
    </nav>
  )
}
