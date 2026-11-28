import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, hotp, matchTotp, newTotpSecret, otpauthUrl, qrCodeDataUrl, totpStep } from './totp.js'

const rfcKey = Buffer.from('12345678901234567890')

describe('one-time passwords', () => {
  it('matches the RFC 4226 HOTP test vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']
    expect(expected.map((_, counter) => hotp(rfcKey, counter))).toEqual(expected)
  })

  it('matches the RFC 6238 TOTP test vectors for SHA-1', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ]
    for (const [seconds, code] of vectors) expect(hotp(rfcKey, totpStep(seconds * 1000), 8)).toBe(code)
  })

  it('round-trips base32 as authenticator apps write it', () => {
    expect(base32Encode(rfcKey)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(rfcKey)
    expect(base32Decode(newTotpSecret())).toHaveLength(20)
    expect(() => base32Decode('not base32!')).toThrow()
  })

  it('accepts the code of the current step and one step either side, and says which', () => {
    const secret = base32Encode(rfcKey)
    const now = 1_700_000_000_000
    const step = totpStep(now)
    expect(matchTotp(secret, hotp(rfcKey, step), now)).toBe(step)
    expect(matchTotp(secret, hotp(rfcKey, step - 1), now)).toBe(step - 1)
    expect(matchTotp(secret, hotp(rfcKey, step + 1), now)).toBe(step + 1)
    expect(matchTotp(secret, hotp(rfcKey, step - 2), now)).toBeNull()
    expect(matchTotp(secret, hotp(rfcKey, step + 2), now)).toBeNull()
    expect(matchTotp(secret, '12345', now)).toBeNull()
    expect(matchTotp(secret, 'abcdef', now)).toBeNull()
  })

  it('builds the otpauth URI and draws its QR code locally', () => {
    const url = otpauthUrl('ABCDEF', 'My Music', 'ada lovelace')
    expect(url).toBe('otpauth://totp/My%20Music:ada%20lovelace?secret=ABCDEF&issuer=My+Music&algorithm=SHA1&digits=6&period=30')
    const image = qrCodeDataUrl(url)
    expect(image).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(Buffer.from(image.split(',')[1]!, 'base64').toString()).toContain('<svg')
  })
})
