import { Check, ChevronDown } from 'lucide-react'
import { Select as SelectPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { menuContentClass, menuItemClass } from './menu'

export type SelectOption<T extends string> = { value: T; label: string }

type SelectProps<T extends string> = {
  value: T
  onValueChange: (value: T) => void
  options: readonly SelectOption<T>[]
  label: string
  /** Text before the value inside the trigger, such as "Sort". */
  prefix?: string
  id?: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
  'aria-describedby'?: string
}

export function Select<T extends string>({ value, onValueChange, options, label, prefix, id, size = 'md', disabled, className, ...props }: SelectProps<T>) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={next => onValueChange(next as T)} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={label}
        aria-describedby={props['aria-describedby']}
        data-slot="select-trigger"
        className={cn(
          'inline-flex w-fit items-center justify-between gap-2 whitespace-nowrap rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/15 dark:hover:bg-input/25',
          size === 'sm' ? 'h-8' : 'h-9',
          // A finger needs 44 px; a mouse keeps the compact control.
          'pointer-coarse:h-11',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {prefix && <span className="text-muted-foreground">{prefix}</span>}
          <span className="truncate"><SelectPrimitive.Value /></span>
        </span>
        <SelectPrimitive.Icon><ChevronDown className="size-4 text-muted-foreground" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className={cn(menuContentClass, 'max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) overflow-y-auto')}>
          <SelectPrimitive.Viewport>
            {options.map(option => (
              <SelectPrimitive.Item key={option.value} value={option.value} className={cn(menuItemClass, 'pr-8')}>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2"><Check className="size-4" /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
