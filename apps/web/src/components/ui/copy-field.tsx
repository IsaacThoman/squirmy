import { Check, Copy } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button } from './button'

/** A value to copy, such as a secret shown once or an invite link. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const field = useRef<HTMLInputElement>(null)
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
    <div className="flex items-center gap-2 rounded-xl bg-surface p-1.5 pl-4">
      <input ref={field} readOnly aria-label={label} value={value} onFocus={event => event.target.select()} className="min-w-0 flex-1 truncate bg-transparent font-mono text-[15px] tracking-wide outline-none" />
      <Button size="sm" variant="primary" onClick={() => void copy()}>
        {copied ? <Check /> : <Copy />}{copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}
