import type { User } from '@squirmy/contracts'
import { ChevronsUpDown, LogOut, Settings, Shield, Upload } from 'lucide-react'
import { useNavigate } from 'react-router'
import { DropdownMenu } from '@/components/ui/menu'
import { canUploadMusic } from '@/lib/catalog'
import { cn } from '@/lib/utils'

export function AccountMenu({ user, onLogout, inSidebar = false }: { user: User; onLogout: () => void; inSidebar?: boolean }) {
  const navigate = useNavigate()
  const name = user.displayName ?? user.username
  return (
    <DropdownMenu
      align={inSidebar ? 'start' : 'end'}
      entries={[
        { kind: 'label', label: name },
        { label: 'Settings', icon: <Settings />, onSelect: () => navigate('/settings') },
        ...(canUploadMusic(user) ? [{ label: 'Add music', icon: <Upload />, onSelect: () => navigate('/imports') }] : []),
        ...(user.role === 'admin' ? [{ label: 'Admin', icon: <Shield />, onSelect: () => navigate('/admin') }] : []),
        { kind: 'separator' },
        { label: 'Log out', icon: <LogOut />, onSelect: onLogout },
      ]}
      trigger={(
        <button type="button" aria-label={`Account, ${name}`} className={cn(
          'flex items-center text-left transition hover:bg-overlay data-[state=open]:bg-overlay',
          inSidebar ? 'sidebar-account min-h-11 w-full gap-2.5 rounded-lg px-2' : 'rounded-full p-0.5',
        )}>
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-selection text-sm font-bold text-accent ring-1 ring-inset ring-accent/25">
            {name.slice(0, 1).toUpperCase()}
          </span>
          {inSidebar && (
            <>
              <span className="sidebar-label min-w-0 flex-1 truncate text-sm font-semibold">{name}</span>
              <ChevronsUpDown aria-hidden className="sidebar-label size-4 shrink-0 text-quiet" />
            </>
          )}
        </button>
      )}
    />
  )
}
