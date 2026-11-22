import { describe, expect, it } from 'vitest'
import { isPublicAddress } from './address.js'

describe('isPublicAddress', () => {
  it('accepts public IPv4 and IPv6 addresses', () => {
    for (const address of ['1.1.1.1', '8.8.4.4', '93.184.216.34', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
      expect(isPublicAddress(address), address).toBe(true)
    }
  })

  it('refuses loopback, private, link-local, CGNAT, unspecified, multicast and reserved addresses', () => {
    for (const address of [
      '127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.251', '239.255.255.250',
      '240.0.0.1', '255.255.255.255', '192.0.0.8', '198.18.0.1',
      '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', 'fec0::1',
    ]) {
      expect(isPublicAddress(address), address).toBe(false)
    }
  })

  it('looks inside IPv4-mapped and NAT64 IPv6 addresses', () => {
    for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:10.1.2.3', '::ffff:a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b::192.168.0.1']) {
      expect(isPublicAddress(address), address).toBe(false)
    }
    expect(isPublicAddress('::ffff:1.1.1.1')).toBe(true)
    expect(isPublicAddress('64:ff9b::808:808')).toBe(true)
  })

  it('refuses anything that is not an IP address', () => {
    for (const value of ['', 'localhost', 'example.com', '1.2.3', '[::1]', '01.02.03.04']) expect(isPublicAddress(value), value).toBe(false)
  })
})
