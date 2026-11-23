import { cn } from '@/lib/utils'

/**
 * The googly worm mascot, as a rounded tile like the app icon. The tile brings its own violet,
 * so it sits on every theme in light and dark alike. The 64 px file covers a 32 px mark on a 2x screen; a denser screen or a
 * larger mark gets the 256 px one.
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <img
      src="/squirmy-mark-64.png"
      srcSet="/squirmy-mark-64.png 64w, /squirmy-mark.png 256w"
      sizes={`${size}px`}
      width={size}
      height={size}
      alt=""
      draggable={false}
      className={cn('shrink-0 select-none', className)}
    />
  )
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <LogoMark size={40} />
      <span className="text-lg font-semibold tracking-tight">Squirmy</span>
    </span>
  )
}
