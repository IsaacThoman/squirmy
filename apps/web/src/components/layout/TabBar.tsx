import { House, Library, Search } from 'lucide-react'
import { Link, useLocation } from 'react-router'

const tabs = [
  { to: '/', label: 'Home', icon: House, match: (path: string) => path === '/' },
  { to: '/search', label: 'Search', icon: Search, match: (path: string) => path === '/search' },
  { to: '/library/albums', label: 'Library', icon: Library, match: (path: string) => /^\/(library|album|artist|playlist|liked|wantlist)(\/|$)/.test(path) },
]

export function TabBar() {
  const { pathname } = useLocation()
  return (
    <nav aria-label="Main" className="flex border-t border-stroke bg-sheet pb-[env(safe-area-inset-bottom)]">
      {tabs.map(({ to, label, icon: Icon, match }) => (
        <Link key={to} to={to} aria-current={match(pathname) ? 'page' : undefined} className="flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-semibold text-quiet transition-colors aria-[current=page]:text-accent">
          <Icon aria-hidden className="size-5" strokeWidth={1.9} />
          {label}
        </Link>
      ))}
    </nav>
  )
}
