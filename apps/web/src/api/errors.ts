import { ApiError } from '@squirmy/client-core'
import { useState } from 'react'
import type { z } from 'zod'

/** Messages keyed by form field, plus `form` for errors that belong to no single field. */
export type FormErrors = { [field: string]: string | undefined; form?: string }

type Issue = { code: string; path: readonly PropertyKey[]; message: string; origin?: string; minimum?: unknown; maximum?: unknown; expected?: string }

/** Zod's default wording reads like a stack trace; these read like a form. */
export function issueMessage(issue: Issue): string {
  const text = issue.origin === 'string'
  if (issue.code === 'too_small') return text ? (issue.minimum === 1 ? 'Required' : `At least ${issue.minimum} characters`) : `At least ${issue.minimum}`
  if (issue.code === 'too_big') return text ? `At most ${issue.maximum} characters` : `At most ${issue.maximum}`
  if (issue.code === 'invalid_type' && issue.expected === 'int') return 'Whole numbers only'
  if (issue.code === 'invalid_type' && issue.expected === 'number') return 'Enter a number'
  return issue.message
}

export function errorsFromIssues(issues: readonly Issue[]): FormErrors {
  const errors: FormErrors = {}
  for (const issue of issues) {
    const field = issue.path.length ? String(issue.path[0]) : 'form'
    errors[field] ??= issueMessage(issue)
  }
  return errors
}

/**
 * A failure the app words itself, for a step of an action the server's own message would not
 * explain (the playlist was made, its songs were not). Shown as it is; `cause` is what failed.
 */
export class ActionError extends Error {
  override readonly name = 'ActionError'
}

/**
 * Words a failed step as `message`, keeping a 401 as it is: the session has ended, and the
 * query client signs out on it.
 */
export function failedStep(error: unknown, message: string): Error {
  if (error instanceof ApiError && error.status === 401) return error
  return new ActionError(message, { cause: error })
}

/** A message for any failed call, worded for people. */
export function errorMessage(error: unknown): string {
  if (error instanceof ActionError) return error.message
  if (error instanceof ApiError) return error.status === 0 ? 'Can’t reach the server. Check your connection and try again.' : error.message
  return 'Something went wrong'
}

/**
 * Maps a failed submit onto the form: the server's validation issues onto their fields,
 * known error codes onto the field they concern (`fields`), anything else onto `form`.
 */
export function errorsFromApi(error: unknown, fields: Record<string, string> = {}): FormErrors {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_request' && Array.isArray(error.details)) return errorsFromIssues(error.details as Issue[])
    const field = fields[error.code]
    if (field) return { [field]: error.message }
  }
  return { form: errorMessage(error) }
}

/**
 * Validates a form's value with a contract schema, then runs `action` with the parsed
 * value. Errors from either step land in `errors`. Resolves to whether it succeeded.
 */
export function useFormSubmit<S extends z.ZodType>(schema: S, action: (data: z.output<S>) => Promise<unknown>, fields?: Record<string, string>) {
  const [errors, setErrors] = useState<FormErrors>({})
  const [pending, setPending] = useState(false)
  const submit = async (value: unknown): Promise<boolean> => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      setErrors(errorsFromIssues(parsed.error.issues as Issue[]))
      return false
    }
    setErrors({})
    setPending(true)
    try {
      await action(parsed.data)
      return true
    } catch (error) {
      setErrors(errorsFromApi(error, fields))
      return false
    } finally {
      setPending(false)
    }
  }
  return { errors, pending, submit, reset: () => setErrors({}) }
}
