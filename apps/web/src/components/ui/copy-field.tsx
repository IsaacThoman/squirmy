import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from './button'

/** A value to copy, such as a secret shown once or an invite link. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  // "Copied" is a confirmation, not a state: it goes back to "Copy" so the next copy shows too.
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      // No clipboard outside secure contexts: select the text so it can be copied by hand.
      field.current?.select()
    }
  }
  return (
    // The field draws no outline of its own (the box is the field), so the box shows the keyboard's focus.
    <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 p-1 pl-3 transition-[box-shadow,border-color] has-[input:focus-visible]:border-ring has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring">
      <input ref={field} readOnly aria-label={label} value={value} onFocus={event => event.target.select()} className="min-w-0 flex-1 truncate bg-transparent font-mono text-sm outline-none" />
      <Button size="sm" variant="primary" onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
