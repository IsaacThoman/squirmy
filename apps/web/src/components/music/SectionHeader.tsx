import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'

type SectionHeaderProps = {
  title: string
  /** Where "See all" leads. */
  href?: string
  action?: ReactNode
  /** A heading inside a titled group, such as "Albums" under "In your library". */
  quiet?: boolean
  className?: string
  id?: string
}

/** The heading of a section of a page, with room for its controls on the right. */
export function SectionHeader({ title, href, action, quiet, className, id }: SectionHeaderProps) {
  return (
    <div className={cn('mb-3 flex min-h-8 items-center justify-between gap-3', className)}>
      <h2 id={id} className={cn('min-w-0 truncate', quiet ? 'text-sm font-medium text-muted-foreground' : 'text-base font-semibold')}>{title}</h2>
      {(action || href) && (
        <div className="flex shrink-0 items-center gap-1">
          {action}
          {href && (
            <Link to={href} className="inline-flex h-8 pointer-coarse:h-11 items-center gap-0.5 rounded-md pl-2.5 pr-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              See all<ChevronRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
