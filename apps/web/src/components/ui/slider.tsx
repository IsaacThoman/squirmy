import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

export type SliderProps = {
  label: string
  value: number
  /** Defaults to 0. */
  min?: number
  max: number
  step?: number
  /** Called while dragging or on each key press. */
  onValueChange: (value: number) => void
  /** Called once the pointer is released or a key press lands. */
  onValueCommit?: (value: number) => void
  valueText?: string
  /** Vertical sliders (an equalizer's bands) fill their box's height and always show their thumb. */
  orientation?: 'horizontal' | 'vertical'
  disabled?: boolean
  className?: string
}

/**
 * A thin track that shows its thumb on hover or focus, like a transport bar. On a touch screen,
 * where nothing hovers, the thumb always shows and the slider is a finger's 44 px tall, the track
 * still thin in its middle.
 */
export function Slider({ label, value, min = 0, max, step = 1, onValueChange, onValueCommit, valueText, orientation = 'horizontal', disabled, className }: SliderProps) {
  const vertical = orientation === 'vertical'
  return (
    <SliderPrimitive.Root
      value={[Math.max(min, Math.min(value, max))]}
      min={min}
      max={max}
      step={step}
      orientation={orientation}
      disabled={disabled}
      onValueChange={([next]) => onValueChange(next)}
      onValueCommit={([next]) => onValueCommit?.(next)}
      className={cn(
        'group relative flex touch-none select-none items-center data-disabled:opacity-40',
        vertical ? 'h-full w-4 flex-col pointer-coarse:w-11' : 'h-4 w-full pointer-coarse:h-11',
        className,
      )}
    >
      {/* The track is the input color, 3:1 off the page and the player: at rest, with the thumb hidden, it is all that shows where the slider is. */}
      <SliderPrimitive.Track className={cn('relative grow overflow-hidden rounded-full bg-input', vertical ? 'w-1' : 'h-1')}>
        <SliderPrimitive.Range className={cn('absolute rounded-full bg-foreground/70 transition-colors duration-150 group-hover:bg-primary group-has-focus-visible:bg-primary', vertical ? 'w-full' : 'h-full')} />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className={cn(
          'block size-3 rounded-full border border-primary bg-background shadow-sm outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-ring',
          vertical ? 'scale-100' : 'scale-0 group-hover:scale-100 focus-visible:scale-100 pointer-coarse:scale-100',
        )}
      />
    </SliderPrimitive.Root>
  )
}
