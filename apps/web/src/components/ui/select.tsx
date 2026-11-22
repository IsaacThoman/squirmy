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
  className?: string
}

export function Select<T extends string>({ value, onValueChange, options, label, prefix, id, className }: SelectProps<T>) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={next => onValueChange(next as T)}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={label}
        className={cn('inline-flex h-9 items-center gap-1.5 rounded-lg border border-stroke bg-background pl-3.5 pr-2.5 text-[13px] font-semibold text-foreground transition duration-150 hover:bg-overlay data-[state=open]:ring-4 data-[state=open]:ring-selection', className)}
      >
        {prefix && <span className="text-muted">{prefix}</span>}
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon><ChevronDown className="size-4 text-muted" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={6} className={cn(menuContentClass, 'min-w-(--radix-select-trigger-width)')}>
          <SelectPrimitive.Viewport>
            {options.map(option => (
              <SelectPrimitive.Item key={option.value} value={option.value} className={cn(menuItemClass, 'pr-8')}>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2.5"><Check className="size-4 text-accent" /></SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
