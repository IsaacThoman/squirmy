import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { walk } from './walk.js'

describe('walk', () => {
  let root = ''
  let outside = ''

  const paths = async (start: string) => {
    const found: string[] = []
    for await (const entry of walk(start, { root, onError: () => {} })) found.push(entry.relPath)
    return found
  }

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-walk-')))
    outside = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-walk-outside-')))
    await mkdir(path.join(root, 'Album'))
    await writeFile(path.join(root, 'Album/01.flac'), 'inside')
    await writeFile(path.join(outside, 'secret.flac'), 'outside')
    await symlink(outside, path.join(root, 'Linked folder'))
    await symlink(path.join(outside, 'secret.flac'), path.join(root, 'Album/02 out.flac'))
    await symlink(path.join(root, 'Album/01.flac'), path.join(root, 'Album/03 in.flac'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('follows links only to files inside the root, for the whole root', async () => {
    expect(await paths('')).toEqual(['Album/01.flac', 'Album/03 in.flac'])
  })

  it('applies the same rule when the scope itself is a link', async () => {
    expect(await paths('Linked folder')).toEqual([])
    expect(await paths('Linked folder/secret.flac')).toEqual([])
    expect(await paths('Album/02 out.flac')).toEqual([])
    expect(await paths('Album/03 in.flac')).toEqual(['Album/03 in.flac'])
    expect(await paths('Album/01.flac')).toEqual(['Album/01.flac'])
    expect(await paths('Album')).toEqual(['Album/01.flac', 'Album/03 in.flac'])
  })
})
