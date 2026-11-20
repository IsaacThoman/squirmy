import { afterEach, describe, expect, it } from 'vitest'
import { resetConfig } from '../config.js'
import { developmentVersion, getVersion } from './version.js'

describe('getVersion', () => {
  // The configuration requires one; nothing here connects.
  process.env.DATABASE_URL ??= 'postgres://localhost/unused'
  afterEach(() => {
    delete process.env.SQUIRMY_VERSION
    resetConfig()
  })

  it('reports SQUIRMY_VERSION when it is set', () => {
    process.env.SQUIRMY_VERSION = '1.4.0'
    resetConfig()
    expect(getVersion()).toBe('1.4.0')
  })

  it('reports a development marker with the commit otherwise', () => {
    // The image sets the variable to an empty string when built without the argument.
    process.env.SQUIRMY_VERSION = ''
    resetConfig()
    expect(getVersion()).toMatch(/^dev\+[0-9a-f]{4,40}$/)
  })

  it('reports dev without git', () => {
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      expect(developmentVersion()).toBe('dev')
    } finally {
      process.env.PATH = path
    }
  })
})
