import { afterEach, describe, expect, it } from 'vitest'
import { resetConfig } from '../config.js'
import { developmentVersion, getVersion } from './version.js'

describe('getVersion', () => {
  // The configuration requires one; nothing here connects.
  process.env.DATABASE_URL ??= 'postgres://localhost/unused'
  afterEach(() => {
    delete process.env.SQUIRMY_VERSION
    delete process.env.SOURCE_COMMIT
    resetConfig()
  })

  it('reports SQUIRMY_VERSION when it is set', () => {
    process.env.SQUIRMY_VERSION = '1.4.0'
    process.env.SOURCE_COMMIT = 'de1060ad51c2768e97e6b84ef8d17c3d7450c848'
    resetConfig()
    expect(getVersion()).toBe('1.4.0')
  })

  it('reports a development marker with the commit otherwise', () => {
    // The image sets the variable to an empty string when built without the argument.
    process.env.SQUIRMY_VERSION = ''
    resetConfig()
    expect(getVersion()).toMatch(/^dev\+[0-9a-f]{4,40}$/)
  })

  it('reports the short SOURCE_COMMIT of a source build', () => {
    process.env.SOURCE_COMMIT = 'DE1060AD51C2768E97E6B84EF8D17C3D7450C848'
    resetConfig()
    expect(developmentVersion()).toBe('dev+de1060a')
  })

  it('reports dev without git or a usable SOURCE_COMMIT', () => {
    const path = process.env.PATH
    process.env.PATH = ''
    try {
      for (const value of ['', 'unknown', 'HEAD']) {
        process.env.SOURCE_COMMIT = value
        resetConfig()
        expect(developmentVersion()).toBe('dev')
      }
    } finally {
      process.env.PATH = path
    }
  })
})
