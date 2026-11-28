import { BlockList, isIPv4, isIPv6 } from 'node:net'

/**
 * Addresses a request for a URL from outside (an image link in provider data) must
 * never reach: this machine, the networks it sits on, cloud metadata services, and
 * anything not routed on the public internet.
 */
const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
  ['64:ff9b:1::', 48], // local-use IPv4 translation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local, deprecated but still routed by some networks
  ['ff00::', 8], // multicast
] as const) blocked.addSubnet(network, prefix, 'ipv6')

/** IPv6 forms that carry an IPv4 address in their last 32 bits, and reach it. */
const embedding = [/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/, /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/]

/** The IPv4 address inside an IPv4-mapped or NAT64 address, or null. */
function embeddedIPv4(address: string): string | null {
  // The URL parser writes every IPv6 address in one canonical, lowercase, hex-only form.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1)
  for (const pattern of embedding) {
    const match = canonical.match(pattern)
    if (!match) continue
    const value = (Number.parseInt(match[1]!, 16) << 16 | Number.parseInt(match[2]!, 16)) >>> 0
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
  }
  return null
}

/** True for an IPv4 or IPv6 address on the public internet. Anything else, names included, is false. */
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address)) return !blocked.check(address, 'ipv4')
  if (!isIPv6(address)) return false
  if (blocked.check(address, 'ipv6')) return false
  const inner = embeddedIPv4(address)
  return inner === null || !blocked.check(inner, 'ipv4')
}
