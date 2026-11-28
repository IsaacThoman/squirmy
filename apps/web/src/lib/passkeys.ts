import { ActionError } from '@/api/errors'
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser'
import type { PasskeyCredential, PasskeyOptions } from '@squirmy/contracts'

/** Whether this browser can make and use passkeys at all; the server says whether it accepts them. */
export function browserSupportsPasskeys(): boolean {
  try {
    return browserSupportsWebAuthn()
  } catch {
    return false
  }
}

/** Closing the browser's passkey sheet is a choice, not a failure: nothing is said. */
export function passkeyCancelled(error: unknown): boolean {
  const named = error as { name?: string; cause?: { name?: string } } | null
  return named?.name === 'NotAllowedError' || named?.name === 'AbortError' || named?.cause?.name === 'NotAllowedError' || named?.cause?.name === 'AbortError'
}

function worded(error: unknown): unknown {
  if (error instanceof WebAuthnError && error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') {
    return new ActionError('This device already has a passkey for your account.', { cause: error })
  }
  if (error instanceof WebAuthnError) return new ActionError('Your browser couldn’t use a passkey here. Try again, or use another device.', { cause: error })
  return error
}

/** Asks the browser to make a passkey from the server's creation options. */
export async function createPasskey(options: PasskeyOptions['options']): Promise<PasskeyCredential> {
  try {
    return await startRegistration({ optionsJSON: options as never }) as unknown as PasskeyCredential
  } catch (error) {
    throw worded(error)
  }
}

/** Asks the browser for any passkey of this server, from the server's request options. */
export async function getPasskey(options: PasskeyOptions['options']): Promise<PasskeyCredential> {
  try {
    return await startAuthentication({ optionsJSON: options as never }) as unknown as PasskeyCredential
  } catch (error) {
    throw worded(error)
  }
}
