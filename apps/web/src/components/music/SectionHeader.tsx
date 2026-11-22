import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

export function SectionHeader({ title, href, action, className, id }: { title: string; href?: string; action?: ReactNode; className?: string; id?: string }) {
  return (
    <div className={cn('mb-3.5 flex min-h-9 items-center justify-between gap-3', className)}>
      <h2 id={id} className="text-xl font-bold tracking-[-0.025em]">{title}</h2>
      <div className="flex items-center gap-1">
        {action}
        {href && (
          <Link to={href} className="group inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-[13px] font-semibold whitespace-nowrap text-muted transition hover:bg-overlay hover:text-foreground">
            See all<ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </div>
    </div>
  )
}

/** The main heading of an app page. */
export function PageTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h1 className={cn('text-[28px] font-bold leading-tight tracking-[-0.04em] md:text-[34px]', className)}>{children}</h1>
}
