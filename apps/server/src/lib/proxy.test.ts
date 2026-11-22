import { describe, expect, it } from 'vitest'
import { addressKey, headerAddress, parseTrustProxy, trustFunction } from './proxy.js'

/** What Fastify (proxy-addr) makes `request.ip` from a socket peer and an X-Forwarded-For header. */
function clientIp(value: string, peer: string, forwardedFor?: string) {
  const trust = trustFunction(parseTrustProxy(value))
  const addrs = [peer, ...(forwardedFor ?? '').split(',').map((entry) => entry.trim()).filter(Boolean).reverse()]
  if (!trust) return peer
  for (let index = 0; index < addrs.length - 1; index++) if (!trust(addrs[index]!, index)) return addrs[index]!
  return addrs[addrs.length - 1]!
}

describe('TRUST_PROXY', () => {
  it('parses every form and refuses nonsense', () => {
    expect(parseTrustProxy('false')).toEqual({ kind: 'none' })
    expect(parseTrustProxy('0')).toEqual({ kind: 'none' })
    expect(parseTrustProxy('TRUE')).toEqual({ kind: 'private' })
    expect(parseTrustProxy('2')).toEqual({ kind: 'hops', hops: 2 })
    expect(parseTrustProxy('127.0.0.1, 172.16.0.0/12,uniquelocal')).toEqual({ kind: 'addresses', list: ['127.0.0.1', '172.16.0.0/12', 'uniquelocal'] })
    expect(() => parseTrustProxy('yes')).toThrow(/not an address/)
    expect(() => parseTrustProxy('10.0.0.0/40')).toThrow(/prefix/)
  })

  it('false: the peer is the client, whatever the headers say', () => {
    expect(clientIp('false', '172.18.0.2', '1.2.3.4')).toBe('172.18.0.2')
  })

  it('true: one proxy on a private network; a client cannot prepend its own address', () => {
    // nginx with $proxy_add_x_forwarded_for appends the real address after the forged one.
    expect(clientIp('true', '172.18.0.2', '6.6.6.6, 203.0.113.9')).toBe('203.0.113.9')
    expect(clientIp('true', '::ffff:127.0.0.1', '203.0.113.9')).toBe('203.0.113.9')
    expect(clientIp('true', '100.101.102.103', '203.0.113.9')).toBe('203.0.113.9')
  })

  it('true: a client on the internet that reaches the port directly is not believed', () => {
    expect(clientIp('true', '198.51.100.7', '10.0.0.1')).toBe('198.51.100.7')
  })

  it('a hop count trusts exactly that many proxies', () => {
    // Cloudflare appends the client, then a local proxy that trusts cloudflared appends cloudflared.
    expect(clientIp('2', '127.0.0.1', '6.6.6.6, 203.0.113.9, 172.18.0.5')).toBe('203.0.113.9')
    expect(clientIp('1', '127.0.0.1', '6.6.6.6, 203.0.113.9, 172.18.0.5')).toBe('172.18.0.5')
    // Junk is never trusted as a hop, so it cannot carry the chain on to a forged address.
    expect(clientIp('3', '127.0.0.1', '6.6.6.6, junk, 203.0.113.9')).toBe('junk')
  })

  it('an address list trusts proxies in it, and stops at the first one outside', () => {
    expect(clientIp('loopback,172.16.0.0/12', '127.0.0.1', '6.6.6.6, 203.0.113.9, 172.18.0.5')).toBe('203.0.113.9')
    expect(clientIp('172.18.0.2', '172.18.0.3', '203.0.113.9')).toBe('172.18.0.3')
  })
})

describe('client address header', () => {
  const trust = trustFunction(parseTrustProxy('true'))
  it('is read only from a trusted peer, and only when it is one address', () => {
    expect(headerAddress('203.0.113.9', '172.18.0.2', trust)).toBe('203.0.113.9')
    expect(headerAddress(' 2001:db8::1 ', '127.0.0.1', trust)).toBe('2001:db8::1')
    expect(headerAddress('203.0.113.9', '198.51.100.7', trust)).toBeUndefined()
    expect(headerAddress('203.0.113.9, 6.6.6.6', '172.18.0.2', trust)).toBeUndefined()
    expect(headerAddress(['203.0.113.9'], '172.18.0.2', trust)).toBeUndefined()
    expect(headerAddress('203.0.113.9', '172.18.0.2', false)).toBeUndefined()
  })
})

describe('addressKey', () => {
  it('counts IPv4 alone and IPv6 per /64', () => {
    expect(addressKey('203.0.113.9')).toBe('203.0.113.9')
    expect(addressKey('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(addressKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(addressKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64')
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(addressKey('::1')).toBe('0:0:0:0::/64')
    expect(addressKey('x'.repeat(200))).toHaveLength(64)
  })
})
