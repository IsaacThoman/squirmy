import type { User } from '@squirmy/contracts'
import { ChevronLeft, ChevronRight, LogOut, Settings, Shield, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu } from '@/components/ui/menu'
import { SearchField } from '@/components/ui/search-field'
import { canUploadMusic } from '@/lib/catalog'
import { useUrlDraft } from '@/lib/use-url-draft'
import { cn } from '@/lib/utils'
import { useScrollContainer } from './scroll-context'

/** History buttons, search and the account menu. Clear until the page scrolls under it. */
export function TopBar({ user, onLogout }: { user: User; onLogout: () => void }) {
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
      <div className="ml-auto">
        <UserMenu user={user} onLogout={onLogout} />
      </div>
    </header>
  )
}

function UserMenu({ user, onLogout }: { user: User; onLogout: () => void }) {
  const navigate = useNavigate()
  const name = user.displayName ?? user.username
  return (
    <DropdownMenu
      entries={[
        { kind: 'label', label: `${name} · ${user.role === 'admin' ? 'Admin' : 'Member'}` },
        { label: 'Settings', icon: <Settings />, onSelect: () => navigate('/settings') },
        ...(canUploadMusic(user) ? [{ label: 'Add music', icon: <Upload />, onSelect: () => navigate('/imports') }] : []),
        ...(user.role === 'admin' ? [{ label: 'Admin', icon: <Shield />, onSelect: () => navigate('/admin') }] : []),
        { kind: 'separator' },
        { label: 'Log out', icon: <LogOut />, onSelect: onLogout },
      ]}
      trigger={(
        <button type="button" aria-label={`Account, ${name}`} className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-bold text-on-accent ring-4 ring-transparent transition hover:ring-selection data-[state=open]:ring-selection">
          {name.slice(0, 1).toUpperCase()}
        </button>
      )}
    />
  )
}
