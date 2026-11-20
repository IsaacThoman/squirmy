import { ApiError } from '@squirmy/client-core'
import { CreateUserRequest, LoginRequest } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { errorMessage, errorsFromApi, errorsFromIssues } from './errors'

describe('form errors', () => {
  it('words schema issues per field', () => {
    const result = CreateUserRequest.safeParse({ username: 'a b', password: 'short' })
    expect(result.success).toBe(false)
    expect(errorsFromIssues(result.error!.issues)).toEqual({
      username: 'Letters, numbers, dots, dashes and underscores only',
      password: 'At least 8 characters',
    })
    expect(errorsFromIssues(LoginRequest.safeParse({ username: '', password: 'x' }).error!.issues)).toEqual({ username: 'Required' })
  })

  it('maps server errors onto fields, the form, or the server’s validation issues', () => {
    expect(errorsFromApi(new ApiError(409, 'username_taken', 'That username is taken'), { username_taken: 'username' })).toEqual({ username: 'That username is taken' })
    expect(errorsFromApi(new ApiError(429, 'rate_limited', 'Too many attempts. Try again in 42 seconds.'))).toEqual({ form: 'Too many attempts. Try again in 42 seconds.' })
    const issues = [{ code: 'too_small', origin: 'string', minimum: 8, path: ['newPassword'], message: 'Too small' }]
    expect(errorsFromApi(new ApiError(400, 'invalid_request', 'The request is not valid', issues))).toEqual({ newPassword: 'At least 8 characters' })
  })

  it('explains network failures', () => {
    expect(errorMessage(new ApiError(0, 'network_error', 'Failed to fetch'))).toMatch(/reach the server/)
    expect(errorMessage(new Error('boom'))).toBe('Something went wrong')
  })
})
