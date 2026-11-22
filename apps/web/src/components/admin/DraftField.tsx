import { Check } from 'lucide-react'
import { useState } from 'react'
import type { z } from 'zod'
import { errorMessage, errorsFromIssues } from '@/api/errors'
import { Spinner } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Saves a settings patch. `inline` says the caller shows the failure itself, next to the
 * field, so the page should not also toast it.
 */
export type SavePatch<P> = (patch: P, how?: { inline: true }) => Promise<unknown>

type DraftFieldProps<P extends object, K extends keyof P & string> = {
  id: string
  field: K
  value: P[K]
  /** The patch schema: a draft is checked with it before it is sent. */
  schema: z.ZodType<P>
  onSave: SavePatch<P>
  className?: string
  unit?: string
  type?: 'text' | 'number'
  inputMode?: 'numeric' | 'decimal' | 'url'
  step?: string
  placeholder?: string
  format?: (value: P[K]) => string
  parse?: (text: string) => unknown
}

const asText = (value: unknown) => String(value ?? '')

/**
 * An input that saves on blur or Enter. Until then it holds a draft, checked with the
 * contract schema; a value the server refuses stays in the field, with the server's reason
 * under it, to be corrected. It is the control of a `Row`: beside the label it lines up
 * on the right, under the label on the left.
 */
export function DraftField<P extends object, K extends keyof P & string>({
  id, field, value, schema, onSave, className, unit, type = 'text', inputMode, step, placeholder, format = asText, parse,
}: DraftFieldProps<P, K>) {
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string>()
  const toValue = parse ?? (type === 'number' ? (text: string) => (text.trim() ? Number(text) : Number.NaN) : (text: string) => text.trim())
  const commit = async () => {
    if (draft === null) return
    const next = toValue(draft)
    const parsed = schema.safeParse({ [field]: next })
    if (!parsed.success) return setError(errorsFromIssues(parsed.error.issues)[field])
    setError(undefined)
    if (next === value) return setDraft(null)
    try {
      await onSave({ [field]: next } as P, { inline: true })
      setDraft(null)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }
  return (
    <div className="flex min-w-0 max-w-full flex-col items-start gap-1 @xl:items-end">
      <div className="flex max-w-full items-center gap-2">
        <Input
          id={id} type={type} inputMode={inputMode} step={step} min={type === 'number' ? 0 : undefined} placeholder={placeholder}
          value={draft ?? format(value)}
          onChange={event => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          className={cn(type === 'number' && 'tabular', className)}
        />
        {unit && <span className="w-7 shrink-0 text-xs text-muted-foreground">{unit}</span>}
      </div>
      {error && <p id={`${id}-error`} className="max-w-80 text-xs text-destructive @xl:text-right">{error}</p>}
    </div>
  )
}

export type SaveState = 'idle' | 'saving' | 'saved'

export function SaveStatus({ status }: { status: SaveState }) {
  if (status === 'idle') return null
  return (
    <span role="status" className="flex h-8 items-center gap-2 text-sm text-muted-foreground">
      {status === 'saving' ? <><Spinner className="size-4" label="Saving" />Saving…</> : <><Check className="size-4 text-primary" />Saved</>}
    </span>
  )
}
