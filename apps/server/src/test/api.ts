import { ApiErrorBody } from '@squirmy/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import type { z } from 'zod'
import { db } from '../database/client.js'
import { createSession } from '../modules/auth/service.js'
import { createUser } from './factories.js'

/** Creates a user with an open session; `headers` signs `app.inject` requests in as them. */
export async function signIn(input: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser(input)
  const { token } = await createSession(db, { userId: user.id, clientKind: 'test' })
  return { ...user, headers: { authorization: `Bearer ${token}` } }
}

/**
 * Asserts the response status and parses the body with its contract schema, so a route
 * that drifts from the contract fails its test. Returns the parsed body.
 */
export function body<Schema extends z.ZodType>(response: LightMyRequestResponse, schema: Schema, status = 200): z.infer<Schema> {
  expect(response.statusCode, response.body).toBe(status)
  return schema.parse(response.json())
}

/** Asserts an error response and returns its stable code. */
export function errorCode(response: LightMyRequestResponse, status: number): string {
  return body(response, ApiErrorBody, status).error.code
}
