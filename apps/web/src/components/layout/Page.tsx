import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** The standard inset for pages in the listening workspace. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-(--gutter) pb-12 pt-7 md:pt-9', className)}>{children}</div>
}
