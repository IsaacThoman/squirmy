import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * An OpenID Connect provider for tests, on localhost: discovery, an authorization step the test
 * approves by hand, a token endpoint that checks the client secret, the code, PKCE and the
 * redirect, RS256 ID tokens, userinfo and a JWKS. Enough for openid-client to run for real.
 */
export type FakeClaims = Record<string, unknown> & { sub: string }

type Grant = { claims: FakeClaims; nonce: string; codeChallenge: string; redirectUri: string; clientId: string }

export class FakeOidcProvider {
  issuer = ''
  readonly clientId = 'squirmy'
  readonly clientSecret = 'fake-client-secret'
  /** Claims userinfo answers with, merged over the ID token's, per subject. */
  readonly userinfo = new Map<string, Record<string, unknown>>()
  /** Set to make the ID token lie about something (a wrong nonce, audience or issuer). */
  tamper: ((claims: Record<string, unknown>) => void) | null = null
  tokenRequests = 0
  /** Who approves at `/authorize` when a browser comes there itself (browser runs; route tests call `approve`). */
  autoApprove: FakeClaims | null = null
  private server: Server | undefined
  private readonly grants = new Map<string, Grant>()
  private readonly tokens = new Map<string, FakeClaims>()
  private readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  private readonly kid = randomBytes(6).toString('hex')

  async start() {
    this.server = createServer((request, response) => void this.handle(request, response))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  /**
   * What the provider does when the person approves at `authorizationUrl`: the redirect back to
   * the client, with a code for `claims`.
   */
  approve(authorizationUrl: string, claims: FakeClaims): URL {
    const url = new URL(authorizationUrl)
    const params = url.searchParams
    if (`${url.origin}${url.pathname}` !== `${this.issuer}/authorize`) throw new Error(`Not this provider: ${authorizationUrl}`)
    if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256') throw new Error('Expected the code flow with PKCE')
    const code = randomBytes(16).toString('base64url')
    this.grants.set(code, {
      claims,
      nonce: params.get('nonce') ?? '',
      codeChallenge: params.get('code_challenge') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
      clientId: params.get('client_id') ?? '',
    })
    const back = new URL(params.get('redirect_uri')!)
    back.searchParams.set('code', code)
    back.searchParams.set('state', params.get('state') ?? '')
    back.searchParams.set('iss', this.issuer)
    return back
  }

  private idToken(claims: Record<string, unknown>) {
    const now = Math.floor(Date.now() / 1000)
    const payload: Record<string, unknown> = { iss: this.issuer, aud: this.clientId, iat: now, exp: now + 300, ...claims }
    this.tamper?.(payload)
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const body = `${encode({ alg: 'RS256', typ: 'JWT', kid: this.kid })}.${encode(payload)}`
    return `${body}.${createSign('RSA-SHA256').update(body).sign(this.keys.privateKey).toString('base64url')}`
  }

  private async handle(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) {
    const url = new URL(request.url ?? '/', this.issuer)
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      })
    }
    if (url.pathname === '/authorize' && this.autoApprove) {
      response.writeHead(302, { location: this.approve(url.href, this.autoApprove).href })
      return response.end()
    }
    if (url.pathname === '/jwks') {
      return send(200, { keys: [{ ...this.keys.publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' }] })
    }
    if (url.pathname === '/userinfo') {
      const claims = this.tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''))
      if (!claims) return send(401, { error: 'invalid_token' })
      return send(200, { sub: claims.sub, ...this.userinfo.get(claims.sub) })
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      this.tokenRequests += 1
      let raw = ''
      for await (const chunk of request) raw += chunk
      const form = new URLSearchParams(raw)
      const basic = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString()
      const [id, secret] = basic.split(':').map(decodeURIComponent)
      if (id !== this.clientId || secret !== this.clientSecret) return send(401, { error: 'invalid_client' })
      const grant = this.grants.get(form.get('code') ?? '')
      this.grants.delete(form.get('code') ?? '')
      if (!grant || form.get('grant_type') !== 'authorization_code') return send(400, { error: 'invalid_grant' })
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url')
      if (challenge !== grant.codeChallenge || form.get('redirect_uri') !== grant.redirectUri) return send(400, { error: 'invalid_grant' })
      const accessToken = randomBytes(16).toString('base64url')
      this.tokens.set(accessToken, grant.claims)
      return send(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: this.idToken({ ...grant.claims, nonce: grant.nonce }) })
    }
    return send(404, { error: 'not_found' })
  }
}
