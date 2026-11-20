import { House, Library, Search } from 'lucide-react'
import { NavLink } from 'react-router'

const tabs = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/search', label: 'Search', icon: Search, end: false },
  { to: '/library', label: 'Library', icon: Library, end: false },
]

/** The phone layout's tabs, as in the iOS app. */
export function TabBar() {
  return (
    <nav aria-label="Main" className="flex border-t border-stroke bg-floating pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl backdrop-saturate-150">
      {tabs.map(({ to, label, icon: Icon, end }) => (
        <NavLink key={to} to={to} end={end} className="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold text-quiet transition-colors aria-[current=page]:text-accent">
          <Icon aria-hidden className="size-6" strokeWidth={1.9} />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}
