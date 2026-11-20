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

/** A thin track that thickens and shows its thumb on hover or focus, like a transport bar. */
export function Slider({ label, value, max, step = 1, onValueChange, onValueCommit, valueText, disabled, className }: SliderProps) {
  return (
    <SliderPrimitive.Root
      value={[Math.min(value, max)]}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={([next]) => onValueChange(next)}
      onValueCommit={([next]) => onValueCommit?.(next)}
      className={cn('group relative flex h-5 w-full touch-none select-none items-center data-disabled:opacity-40', className)}
    >
      <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-full bg-stroke transition-[height] duration-150 group-hover:h-1.5 group-has-focus-visible:h-1.5">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-foreground transition-colors duration-150 group-hover:bg-accent group-has-focus-visible:bg-accent" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className="block size-3.5 scale-0 rounded-full bg-foreground shadow-md transition-transform duration-150 group-hover:scale-100 focus-visible:scale-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
    </SliderPrimitive.Root>
  )
}
