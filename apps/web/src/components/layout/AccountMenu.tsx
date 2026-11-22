import type { User } from '@squirmy/contracts'
import { ChevronsUpDown, LogOut, Settings, Shield } from 'lucide-react'
import { useRef } from 'react'
import { useNavigate } from 'react-router'
import { DropdownMenu } from '@/components/ui/menu'
import { cn } from '@/lib/utils'

export function AccountMenu({ user, compact, onOpenSettings, onNavigate, onLogout }: {
  user: User
  compact: boolean
  onOpenSettings: (trigger: HTMLButtonElement | null) => void
  onNavigate?: () => void
  onLogout: () => void
}) {
  const navigate = useNavigate()
  const trigger = useRef<HTMLButtonElement>(null)
  const name = user.displayName || user.username
  return (
    <DropdownMenu
      align="start"
      entries={[
        { kind: 'label', label: `${name} · ${user.role === 'admin' ? 'Admin' : 'Member'}` },
        { kind: 'separator' },
        { label: 'Settings', icon: <Settings />, onSelect: () => onOpenSettings(trigger.current) },
        ...(user.role === 'admin' ? [{
          label: 'Admin',
          icon: <Shield />,
          onSelect: () => {
            onNavigate?.()
            void navigate('/admin')
          },
        }] : []),
        { kind: 'separator' },
        { label: 'Log out', icon: <LogOut />, danger: true, onSelect: onLogout },
      ]}
      trigger={(
        <button ref={trigger} type="button" aria-label={`Account, ${name}`} className={cn('flex h-12 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors hover:bg-overlay data-[state=open]:bg-overlay', compact && 'justify-center px-0')}>
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-selection text-sm font-bold text-accent">{name.slice(0, 1).toUpperCase()}</span>
          {!compact && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{name}</span>
                <span className="block truncate text-xs text-muted">@{user.username}</span>
              </span>
              <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-quiet" />
            </>
          )}
        </button>
      )}
    />
  )
}
