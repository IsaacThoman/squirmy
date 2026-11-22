import { BlockList, isIP, isIPv4 } from 'node:net'

/**
 * Which peers may tell the server who the client is (`X-Forwarded-For`, `-Proto`, `-Host`).
 *
 * - `none`: nobody; the socket's address is the client.
 * - `private`: one proxy on this machine or a private network (`TRUST_PROXY=true`). A
 *   client on the internet that reaches the port directly cannot spoof its address.
 * - `hops`: that many proxies, whatever their address. Only safe when the port is reachable
 *   through the proxies alone.
 * - `addresses`: any number of proxies, each of them in the list.
 */
export type TrustProxy =
  | { kind: 'none' }
  | { kind: 'private' }
  | { kind: 'hops'; hops: number }
  | { kind: 'addresses'; list: string[] }

/** Named ranges, as Express and Fastify spell them, plus `private` for all of them and CGNAT. */
const presets: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
}
// Tailscale and other overlay networks hand out 100.64.0.0/10; carrier NAT addresses in it
// never reach a server over the internet, so a peer there is on the operator's own network.
presets.private = [...presets.loopback!, ...presets.linklocal!, ...presets.uniquelocal!, '100.64.0.0/10']

/** Parses `TRUST_PROXY`. Throws with a readable message on a value it does not understand. */
export function parseTrustProxy(raw: string): TrustProxy {
  const value = raw.trim().toLowerCase()
  if (value === '' || value === 'false' || value === '0') return { kind: 'none' }
  if (value === 'true') return { kind: 'private' }
  if (/^\d+$/.test(value)) return { kind: 'hops', hops: Number(value) }
  const list = value.split(',').map((entry) => entry.trim()).filter(Boolean)
  addressList(list)
  return { kind: 'addresses', list }
}

/** IPv4 clients of a dual-stack socket appear as `::ffff:a.b.c.d`. */
function unmapped(address: string): string {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  return match ? match[1]! : address
}

function addressList(entries: string[]): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const expanded = presets[entry]
    if (expanded) {
      for (const range of expanded) addRange(list, range)
      continue
    }
    addRange(list, entry)
  }
  return list
}

function addRange(list: BlockList, entry: string) {
  const [address = '', prefix] = entry.split('/')
  const type = isIP(address)
  if (!type) throw new Error(`"${entry}" is not an address, a CIDR range or one of ${Object.keys(presets).join(', ')}`)
  const family = type === 4 ? 'ipv4' : 'ipv6'
  if (prefix === undefined) {
    list.addAddress(address, family)
    return
  }
  const bits = Number(prefix)
  if (!/^\d+$/.test(prefix) || bits > (type === 4 ? 32 : 128)) throw new Error(`"${entry}" has an invalid prefix length`)
  list.addSubnet(address, bits, family)
}

function contains(list: BlockList, address: string): boolean {
  const plain = unmapped(address)
  const type = isIP(plain)
  return type !== 0 && list.check(plain, type === 4 ? 'ipv4' : 'ipv6')
}

/**
 * Fastify's `trustProxy` as a function: `hop` 0 is the socket's peer, 1 the address that
 * peer reported, and so on. Fastify stops at the first untrusted one, which becomes
 * `request.ip`. Entries that are not addresses are never trusted, so junk a client wrote
 * into `X-Forwarded-For` cannot extend the chain.
 */
export function trustFunction(trust: TrustProxy): ((address: string, hop: number) => boolean) | false {
  switch (trust.kind) {
    case 'none':
      return false
    case 'private': {
      const list = addressList(['private'])
      return (address, hop) => hop === 0 && contains(list, address)
    }
    case 'hops':
      return trust.hops === 0 ? false : (address, hop) => hop < trust.hops && isIP(unmapped(address)) !== 0
    case 'addresses': {
      const list = addressList(trust.list)
      return (address) => contains(list, address)
    }
  }
}

/**
 * The value of a header such as `CF-Connecting-IP`, which the outermost proxy sets to the
 * client's address, when the request came from a trusted proxy and the value is one
 * address. Anything else is ignored, so a client that reaches the server directly cannot
 * choose its address with it.
 */
export function headerAddress(
  value: string | string[] | undefined,
  peer: string | undefined,
  trust: ((address: string, hop: number) => boolean) | false,
): string | undefined {
  if (!trust || !peer || typeof value !== 'string' || !trust(peer, 0)) return undefined
  const address = unmapped(value.trim())
  return isIP(address) ? address : undefined
}

/**
 * The key per-address limits count under. IPv4 addresses count alone. An IPv6 client
 * usually controls a whole /64 and can pick a new address for every request, so IPv6
 * counts per /64. Anything that is not an address (a misconfigured proxy chain) is used
 * as is, bounded in length.
 */
export function addressKey(address: string): string {
  const plain = unmapped(address)
  if (isIPv4(plain)) return plain
  if (isIP(plain) !== 6) return plain.slice(0, 64)
  return `${expandIpv6(plain).slice(0, 4).join(':')}::/64`
}

function expandIpv6(address: string): string[] {
  const withoutZone = address.split('%')[0]!
  // A trailing dotted quad (::ffff:1.2.3.4 and friends) is two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(withoutZone)
  let text = withoutZone
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number]
    text = withoutZone.slice(0, -dotted[1]!.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail] = text.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const missing = tail === undefined ? 0 : 8 - left.length - right.length
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((group) => (Number.parseInt(group, 16) || 0).toString(16))
}
