import { ChevronLeft, ChevronRight, Menu, Search } from 'lucide-react'
import { useEffect, useState, type Ref } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router'
import { IconButton } from '@/components/ui/icon-button'
import { DialogTrigger } from '@/components/ui/dialog'
import { SearchField } from '@/components/ui/search-field'
import { useUrlDraft } from '@/lib/use-url-draft'
import { cn } from '@/lib/utils'
import { useScrollContainer } from './scroll-context'

/** Navigation and search over the scrolling music page. */
export function TopBar({ navigationTrigger }: { navigationTrigger: Ref<HTMLButtonElement> }) {
  const navigate = useNavigate()
  const location = useLocation()
  const [params] = useSearchParams()
  const scroller = useScrollContainer()
  const [scrolled, setScrolled] = useState(false)
  const onSearch = location.pathname === '/search'
  const [query, setQuery] = useUrlDraft(onSearch ? params.get('q') ?? '' : '')

  useEffect(() => {
    if (!scroller) return
    const update = () => setScrolled(scroller.scrollTop > 24)
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [scroller])

  const canGoBack = (window.history.state as { idx?: number } | null)?.idx !== 0

  return (
    <header
      className={cn(
        'sticky top-0 z-20 -mb-14 flex h-14 items-center gap-2 px-(--gutter) transition-[background-color,backdrop-filter,box-shadow] duration-200 md:-mb-16 md:h-16',
        scrolled && 'bg-background/80 shadow-[0_1px_0_var(--stroke)] backdrop-blur-xl backdrop-saturate-150',
      )}
    >
      <DialogTrigger asChild>
        <IconButton ref={navigationTrigger} label="Open navigation" variant="solid" tooltip={false} className="bg-overlay md:hidden"><Menu /></IconButton>
      </DialogTrigger>
      <div className="flex gap-1.5">
        <IconButton label="Go back" variant="solid" size="sm" disabled={!canGoBack} onClick={() => navigate(-1)} className="bg-overlay backdrop-blur-md"><ChevronLeft /></IconButton>
        <IconButton label="Go forward" variant="solid" size="sm" onClick={() => navigate(1)} className="bg-overlay backdrop-blur-md max-md:hidden"><ChevronRight /></IconButton>
      </div>
      <SearchField
        value={query}
        onValueChange={value => {
          setQuery(value)
          void navigate(`/search${value ? `?q=${encodeURIComponent(value)}` : ''}`, { replace: onSearch })
        }}
        placeholder="Songs, albums, artists"
        aria-label="Search"
        className="ml-1 w-full max-w-sm max-md:hidden"
      />
      {!onSearch && (
        <Link to="/search" aria-label="Search" className="ml-auto grid size-10 place-items-center rounded-full bg-overlay text-muted hover:text-foreground md:hidden">
          <Search aria-hidden className="size-5" />
        </Link>
      )}
    </header>
  )
}
