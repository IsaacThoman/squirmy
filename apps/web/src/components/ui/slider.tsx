import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export type SliderProps = {
  label: string
  value: number
  max: number
  step?: number
  /** Called while dragging or on each key press. */
  onValueChange: (value: number) => void
  /** Called once the pointer is released or a key press lands. */
  onValueCommit?: (value: number) => void
  valueText?: string
  disabled?: boolean
  className?: string
}

/**
 * A thin track that shows its thumb on hover or focus, like a transport bar. On a touch screen,
 * where nothing hovers, the thumb always shows and the target is taller.
 */
export function Slider({ label, value, max, step = 1, onValueChange, onValueCommit, valueText, disabled, className }: SliderProps) {
  return (
    <SliderPrimitive.Root
      value={[Math.min(value, max)]}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={([next]) => onValueChange(next)}
      onValueCommit={([next]) => onValueCommit?.(next)}
      className={cn('group relative flex h-4 w-full touch-none select-none items-center data-disabled:opacity-40 pointer-coarse:h-6', className)}
    >
      {/* The track is the input color, 3:1 off the page and the player: at rest, with the thumb hidden, it is all that shows where the slider is. */}
      <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-full bg-input">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-foreground/70 transition-colors duration-150 group-hover:bg-primary group-has-focus-visible:bg-primary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className="block size-3 scale-0 rounded-full border border-primary bg-background shadow-sm outline-none transition-transform duration-150 group-hover:scale-100 focus-visible:scale-100 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:scale-100"
      />
    </SliderPrimitive.Root>
  )
}
