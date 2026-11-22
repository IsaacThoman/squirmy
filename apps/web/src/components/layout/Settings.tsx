import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

type SettingsLink = { to: string; label: string; icon?: ReactNode; badge?: ReactNode }

export function SettingsNav({ label, items, active, className }: { label: string; items: readonly SettingsLink[]; active: string; className?: string }) {
  const nav = useRef<HTMLElement>(null)
  useEffect(() => {
    const container = nav.current
    const link = container?.querySelector<HTMLElement>('[aria-current="page"]')
    if (!container || !link) return
    if (link.offsetLeft < container.scrollLeft) container.scrollLeft = link.offsetLeft
    else if (link.offsetLeft + link.offsetWidth > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = link.offsetLeft + link.offsetWidth - container.clientWidth
    }
  }, [active])

  return (
    <nav ref={nav} aria-label={label} className={cn('relative flex min-w-0 gap-1 overflow-x-auto', className)}>
      {items.map(({ to, label: name, icon, badge }) => (
        <Link
          key={to}
          to={to}
          aria-current={active === to ? 'page' : undefined}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-muted outline-offset-[-2px] transition-colors hover:bg-overlay hover:text-foreground aria-[current=page]:bg-selection aria-[current=page]:text-accent [&>svg]:size-4 [&>svg]:shrink-0"
        >
          {icon}{name}{badge}
        </Link>
      ))}
    </nav>
  )
}

/** A titled group of settings rows on a surface card. */
export function SettingsSection({ title, description, action, children, className }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('@container flex flex-col gap-3', className)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {description && <p className="mt-1 max-w-prose text-sm text-muted">{description}</p>}
        </div>
        {action}
      </div>
      <div className="divide-y divide-stroke rounded-xl border border-stroke bg-background">{children}</div>
    </section>
  )
}

export function SettingRow({ label, description, htmlFor, children }: { label: ReactNode; description?: ReactNode; htmlFor?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 @[28rem]:flex-row @[28rem]:items-center @[28rem]:justify-between">
      <div className="min-w-0">
        {htmlFor ? <label htmlFor={htmlFor} className="text-sm font-semibold">{label}</label> : <div className="text-sm font-semibold">{label}</div>}
        {description && <div className="mt-1 text-[13px] leading-relaxed text-muted">{description}</div>}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2 @[28rem]:shrink-0 [&>*]:max-w-full">{children}</div>}
    </div>
  )
}
