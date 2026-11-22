import type { User } from '@squirmy/contracts'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { IconButton } from '@/components/ui/icon-button'
import { SearchField } from '@/components/ui/search-field'
import { useUrlDraft } from '@/lib/use-url-draft'
import { cn } from '@/lib/utils'
import { AccountMenu, Logo } from './Sidebar'

/** Navigation history and search for the listening workspace. */
export function TopBar({ user, onLogout, mobileNavigation }: { user: User; onLogout: () => void; mobileNavigation: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const header = useRef<HTMLElement>(null)
  const onSearch = location.pathname === '/search'
  const [query, setQuery] = useUrlDraft(onSearch ? params.get('q') ?? '' : '')
  const shortcut = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘ K' : 'Ctrl K'

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.defaultPrevented) return
      const input = header.current?.querySelector('input')
      if (!input?.offsetParent || input.closest('[aria-hidden="true"]')) return
      event.preventDefault()
      input.focus()
      input.select()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  const canGoBack = (window.history.state as { idx?: number } | null)?.idx !== 0

  return (
    <header ref={header} className="flex h-[calc(3.5rem+env(safe-area-inset-top))] shrink-0 items-center gap-2 border-b border-stroke bg-background px-(--gutter) pt-[env(safe-area-inset-top)] md:h-14 md:pt-0">
      {mobileNavigation}
      <Link to="/" aria-label="Squirmy home" className="mr-auto rounded-lg md:hidden">
        <Logo className="[&>svg]:size-6" />
      </Link>
      <div className="flex gap-0.5">
        <IconButton label="Go back" size="sm" disabled={!canGoBack} onClick={() => navigate(-1)} className="rounded-lg"><ChevronLeft /></IconButton>
        <IconButton label="Go forward" size="sm" onClick={() => navigate(1)} className="rounded-lg max-md:hidden"><ChevronRight /></IconButton>
      </div>
      <div className="relative hidden w-full max-w-[24rem] md:block">
        <SearchField
          value={query}
          onValueChange={value => {
            setQuery(value)
            void navigate(`/search${value ? `?q=${encodeURIComponent(value)}` : ''}`, { replace: onSearch })
          }}
          placeholder="Search songs, albums, artists"
          aria-label="Search"
          aria-keyshortcuts="Meta+k Control+k"
          className={cn(
            '[&>input]:h-9 [&>input]:text-[13px]',
            !query && '[&>input]:pr-17',
          )}
        />
        {!query && <kbd aria-hidden className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-stroke bg-background px-1.5 py-0.5 font-sans text-[10px] font-medium leading-none text-quiet">{shortcut}</kbd>}
      </div>
      <AccountMenu user={user} onLogout={onLogout} compact className="md:hidden" />
    </header>
  )
}
