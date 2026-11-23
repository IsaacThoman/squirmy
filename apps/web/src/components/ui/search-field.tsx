import { Search, X } from 'lucide-react'
import { useRef, type ComponentProps } from 'react'
import { cn } from '@/lib/utils'

type SearchFieldProps = Omit<ComponentProps<'input'>, 'value' | 'onChange' | 'size'> & {
  value: string
  onValueChange: (value: string) => void
  size?: 'md' | 'lg'
}

export function SearchField({ value, onValueChange, size = 'md', className, placeholder = 'Search', onKeyDown, ...props }: SearchFieldProps) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className={cn('group relative flex items-center', className)}>
      <Search aria-hidden className={cn('pointer-events-none absolute text-muted-foreground', size === 'lg' ? 'left-3.5 size-[18px]' : 'left-3 size-4')} />
      <input
        ref={input}
        type="search"
        value={value}
        onChange={event => onValueChange(event.target.value)}
        onKeyDown={event => {
          onKeyDown?.(event)
          if (event.key === 'Escape' && value && !event.defaultPrevented) {
            event.preventDefault()
            onValueChange('')
          }
        }}
        placeholder={placeholder}
        aria-label={props['aria-label'] ?? placeholder}
        autoComplete="off"
        spellCheck={false}
        className={cn(
          'w-full min-w-0 rounded-md border border-input bg-transparent shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring dark:bg-input/15 [&::-webkit-search-cancel-button]:hidden',
          // 16px on phones: iOS zooms into any smaller field that gets focus.
          size === 'lg' ? 'h-11 rounded-lg pl-10 pr-10 text-base' : 'h-9 pl-9 pr-9 text-base md:text-sm pointer-coarse:h-11',
        )}
        {...props}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onValueChange('')
            input.current?.focus()
          }}
          className="touch-target absolute right-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}
