import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Standard page padding, clear of the top bar. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-(--gutter) pb-12 pt-16 md:pt-20', className)}>{children}</div>
}
