import { afterEach, describe, expect, it } from 'vitest'
import { getConfig, resetConfig } from './config.js'

describe('config', () => {
  const saved = { DATABASE_URL: process.env.DATABASE_URL, PUBLIC_URL: process.env.PUBLIC_URL }
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetConfig()
  })

  // docs/server/troubleshooting.md quotes this message.
  it('says DATABASE_URL is required when it is missing or empty', () => {
    delete process.env.DATABASE_URL
    resetConfig()
    expect(() => getConfig()).toThrow('DATABASE_URL is required')
    process.env.DATABASE_URL = ''
    resetConfig()
    expect(() => getConfig()).toThrow('DATABASE_URL is required')
  })

  // compose.yaml passes PUBLIC_URL through as ${PUBLIC_URL:-}, which is empty when it is not set.
  it('treats an empty PUBLIC_URL as not set and refuses one that is not a URL', () => {
    process.env.DATABASE_URL = 'postgres://localhost/squirmy'
    process.env.PUBLIC_URL = ''
    resetConfig()
    expect(getConfig().PUBLIC_URL).toBeUndefined()
    process.env.PUBLIC_URL = 'https://music.example.com'
    resetConfig()
    expect(getConfig().PUBLIC_URL).toBe('https://music.example.com')
    process.env.PUBLIC_URL = 'music.example.com'
    resetConfig()
    expect(() => getConfig()).toThrow()
  })
})
