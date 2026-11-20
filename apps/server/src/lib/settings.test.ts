import { describe, expect, it } from 'vitest'
import { useTestDatabase } from '../test/database.js'
import { decrypt, encrypt, hashToken, randomToken, sign, verify } from './crypto.js'
import { getServerSecret, getServerSettings, updateServerSettings } from './settings.js'

describe('crypto and settings', () => {
  useTestDatabase()

  it('signs, verifies and encrypts per purpose', () => {
    const signature = sign('stream', 'file-1')
    expect(verify('stream', 'file-1', signature)).toBe(true)
    expect(verify('stream', 'file-2', signature)).toBe(false)
    expect(verify('other', 'file-1', signature)).toBe(false)
    const sealed = encrypt('app-password', 'hunter2')
    expect(sealed).not.toContain('hunter2')
    expect(decrypt('app-password', sealed)).toBe('hunter2')
    expect(() => decrypt('other', sealed)).toThrow()
    expect(hashToken(randomToken())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('applies defaults, stores updates and keeps secrets write-only', async () => {
    const initial = await getServerSettings()
    expect(initial.deezerEnabled).toBe(true)
    expect(initial.acoustIdKeySet).toBe(false)

    const updated = await updateServerSettings({ deezerEnabled: false, acoustIdKey: 'abc123' })
    expect(updated.deezerEnabled).toBe(false)
    expect(updated.acoustIdKeySet).toBe(true)
    expect(JSON.stringify(updated)).not.toContain('abc123')
    expect(await getServerSecret('acoustIdKey')).toBe('abc123')

    const cleared = await updateServerSettings({ acoustIdKey: null })
    expect(cleared.acoustIdKeySet).toBe(false)
    expect(cleared.deezerEnabled).toBe(false)
  })
})
