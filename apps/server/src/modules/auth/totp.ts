import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { renderSVG } from 'uqr'

/**
 * Time-based one-time passwords (RFC 6238) as authenticator apps make them: HMAC-SHA1,
 * six digits, a 30-second step. Those are the only parameters every app supports, so they
 * are the only ones offered.
 */
export const TOTP_STEP_SECONDS = 30
const digits = 6
/** Steps either side of now still accepted, for a phone clock a little off. */
const drift = 1

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const output: number[] = []
  for (const char of clean) {
    const index = alphabet.indexOf(char)
    if (index === -1) throw new Error('Not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(output)
}

/** 160 bits, the HMAC-SHA1 key size RFC 4226 recommends. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** RFC 4226 HOTP. `length` other than 6 is only for the RFC's test vectors. */
export function hotp(key: Buffer, counter: number, length = digits): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', key).update(message).digest()
  const offset = hmac[hmac.length - 1]! & 0xf
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff
  return String(binary % 10 ** length).padStart(length, '0')
}

export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS)
}

/**
 * The time step `code` belongs to, within the allowed drift, or null. The caller refuses a step
 * at or before the last one it accepted, so a code that was seen cannot be used again.
 */
export function matchTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secret)
  const given = Buffer.from(code)
  const current = totpStep(now)
  let matched: number | null = null
  // Every candidate is compared, so the time taken does not say which step matched.
  for (let step = current - drift; step <= current + drift; step += 1) {
    if (timingSafeEqual(Buffer.from(hotp(key, step)), given) && matched === null) matched = step
  }
  return matched
}

/**
 * The `otpauth://` URI authenticator apps scan. The label is "issuer:account", and the issuer
 * is repeated as a parameter, as Google Authenticator's key URI format asks.
 */
export function otpauthUrl(secret: string, issuer: string, account: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(digits), period: String(TOTP_STEP_SECONDS) })
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * The QR code as an SVG data URL, drawn here so the secret never goes to a third-party QR
 * service. The Content-Security-Policy allows `data:` images.
 */
export function qrCodeDataUrl(text: string): string {
  const svg = renderSVG(text, { ecc: 'M', border: 2, pixelSize: 8 })
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}
