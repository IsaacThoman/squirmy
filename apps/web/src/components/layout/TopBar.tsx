import type { User } from '@squirmy/contracts'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { IconButton } from '@/components/ui/icon-button'
import { SearchField } from '@/components/ui/search-field'
import { useUrlDraft } from '@/lib/use-url-draft'
import { cn } from '@/lib/utils'
import { AccountMenu } from './AccountMenu'
import { useScrollContainer } from './scroll-context'

export function TopBar({ user, onLogout, mobileNavigation }: { user: User; onLogout: () => void; mobileNavigation: ReactNode }) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [params] = useSearchParams()
  const scroller = useScrollContainer()
  const [scrolled, setScrolled] = useState(false)
  const onSearch = pathname === '/search'
  const [query, setQuery] = useUrlDraft(onSearch ? params.get('q') ?? '' : '')

  useEffect(() => {
    if (!scroller) return
    const update = () => setScrolled(scroller.scrollTop > 8)
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [scroller])

  const canGoBack = (window.history.state as { idx?: number } | null)?.idx !== 0

  return (
    <header className={cn(
      'workspace-header sticky top-0 z-20 -mb-14 flex h-14 items-center gap-2 px-(--gutter) md:-mb-16 md:h-16',
      scrolled && 'workspace-header-scrolled',
    )}>
      <div className="flex items-center gap-1">
        {mobileNavigation}
        <IconButton label="Go back" size="sm" disabled={!canGoBack} onClick={() => navigate(-1)} className="rounded-lg"><ChevronLeft /></IconButton>
        <IconButton label="Go forward" size="sm" onClick={() => navigate(1)} className="rounded-lg max-md:hidden"><ChevronRight /></IconButton>
      </div>
      <SearchField
        value={query}
        onValueChange={value => {
          setQuery(value)
          void navigate(`/search${value ? `?q=${encodeURIComponent(value)}` : ''}`, { replace: onSearch })
        }}
        placeholder="Search songs, albums, artists"
        aria-label="Search"
        className="workspace-search ml-1 w-full max-w-sm max-md:hidden"
      />
      <div className="ml-auto md:hidden">
        <AccountMenu user={user} onLogout={onLogout} />
      </div>
    </header>
  )
}
