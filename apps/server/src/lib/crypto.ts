import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getConfig } from '../config.js'

let rootSecret: Buffer | undefined
let rootSecretSource: string | undefined
const keys = new Map<string, Buffer>()

/**
 * The root secret: SQUIRMY_SECRET when set, otherwise a random value generated once
 * and kept in the data directory so a self-hoster does not have to invent one.
 */
function getRootSecret(): Buffer {
  const config = getConfig()
  const source = config.SQUIRMY_SECRET ?? `file:${config.SQUIRMY_DATA_DIR}`
  if (rootSecret && rootSecretSource === source) return rootSecret
  keys.clear()
  rootSecretSource = source
  if (config.SQUIRMY_SECRET) {
    rootSecret = Buffer.from(config.SQUIRMY_SECRET, 'utf8')
    return rootSecret
  }
  const file = path.join(config.SQUIRMY_DATA_DIR, 'secret.key')
  if (!existsSync(file)) {
    mkdirSync(config.SQUIRMY_DATA_DIR, { recursive: true })
    try {
      writeFileSync(file, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      // Another process created it between the check and the write; read theirs.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  rootSecret = Buffer.from(readFileSync(file, 'utf8').trim(), 'utf8')
  return rootSecret
}

/** A 32-byte key for one purpose, so a signature can never be replayed as another kind. */
function keyFor(purpose: string): Buffer {
  const root = getRootSecret()
  let key = keys.get(purpose)
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), `squirmy:${purpose}`, 32))
    keys.set(purpose, key)
  }
  return key
}

/** A URL-safe random token. 32 bytes is 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** SHA-256 hex. Tokens are stored only in this form. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sign(purpose: string, message: string): string {
  return createHmac('sha256', keyFor(purpose)).update(message).digest('base64url')
}

export function verify(purpose: string, message: string, signature: string): boolean {
  const expected = Buffer.from(sign(purpose, message))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** AES-256-GCM. Output is base64url of iv (12) + tag (16) + ciphertext. */
export function encrypt(purpose: string, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFor(purpose), iv)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')
}

export function decrypt(purpose: string, payload: string): string {
  const raw = Buffer.from(payload, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(purpose), raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}
