import { cn } from '@/lib/utils'

/** The Squirmy mark in the theme's action color. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 64 64" className={cn('size-6 shrink-0', className)}>
      <rect width="64" height="64" rx="16" className="fill-primary" />
      <path d="M14 38c4-10 8-10 12 0s8 10 12 0 8-10 12 0" fill="none" strokeWidth="6" strokeLinecap="round" className="stroke-primary-foreground" />
    </svg>
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <LogoMark className="size-8" />
      <span className="text-lg font-semibold tracking-tight">Squirmy</span>
    </span>
  )
}
