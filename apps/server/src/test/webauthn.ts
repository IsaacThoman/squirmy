import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'

/**
 * A software passkey for tests: makes the registration and assertion responses a browser
 * would send, signed with a real P-256 key, so the server's verification runs for real.
 */

type Cbor = number | string | Buffer | Cbor[] | Map<number | string, Cbor>

/** Just enough CBOR (RFC 8949) for an attestation object and a COSE key. */
function cbor(value: Cbor): Buffer {
  const head = (major: number, length: number) => {
    if (length < 24) return Buffer.from([(major << 5) | length])
    if (length < 256) return Buffer.from([(major << 5) | 24, length])
    const buffer = Buffer.alloc(3)
    buffer[0] = (major << 5) | 25
    buffer.writeUInt16BE(length, 1)
    return buffer
  }
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)])
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value])
  if (Array.isArray(value)) return Buffer.concat([head(4, value.length), ...value.map(cbor)])
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)])])
}

const b64url = (buffer: Buffer) => buffer.toString('base64url')
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest()

export class SoftPasskey {
  readonly credentialId = randomBytes(16)
  private readonly privateKey: KeyObject
  private readonly publicJwk: { x: string; y: string }
  private counter = 0
  /** The user handle the server gave at registration, sent back with each assertion. */
  userHandle: string | undefined

  constructor(readonly origin: string, readonly rpId = new URL(origin).hostname, private readonly userVerified = true) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    this.publicJwk = jwk
  }

  get id(): string {
    return b64url(this.credentialId)
  }

  private flags(attested: boolean) {
    // UP, UV when the user was verified, and AT on registration.
    return 0x01 | (this.userVerified ? 0x04 : 0) | (attested ? 0x40 : 0)
  }

  private clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin = this.origin) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  /** The `RegistrationResponseJSON` for creation options from the server. */
  register(options: { challenge: string; user: { id: string } }, origin?: string) {
    this.userHandle = options.user.id
    const coseKey = cbor(new Map<number, Cbor>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(this.publicJwk.x, 'base64url')],
      [-3, Buffer.from(this.publicJwk.y, 'base64url')],
    ]))
    const length = Buffer.alloc(2)
    length.writeUInt16BE(this.credentialId.length)
    const authData = Buffer.concat([
      sha256(this.rpId), Buffer.from([this.flags(true)]), Buffer.alloc(4),
      Buffer.alloc(16), length, this.credentialId, coseKey,
    ])
    const attestationObject = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(this.clientData('webauthn.create', options.challenge, origin)),
        attestationObject: b64url(attestationObject),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  /** The `AuthenticationResponseJSON` for request options from the server. */
  authenticate(options: { challenge: string }, origin?: string) {
    this.counter += 1
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([this.flags(false)]), counter])
    const clientData = this.clientData('webauthn.get', options.challenge, origin)
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.privateKey)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }
}
