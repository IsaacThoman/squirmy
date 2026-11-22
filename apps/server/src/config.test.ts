import { afterEach, describe, expect, it } from 'vitest'
import { getConfig, resetConfig } from './config.js'

describe('config', () => {
  const saved = process.env.DATABASE_URL
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
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
})
