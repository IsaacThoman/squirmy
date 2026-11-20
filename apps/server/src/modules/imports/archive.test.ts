import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractArchive, inspectArchive, type ArchiveLimits } from './archive.js'
import { checkRelativePath, fileKind } from './paths.js'
import { writeZip } from './test-zip.js'

const limits: ArchiveLimits = { maxEntries: 100, maxEntryBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 }

describe('import path rules', () => {
  it('accepts audio, sidecars and archives by name', () => {
    expect(['a.flac', 'b.MP3', 'cover.jpg', 'Folder.PNG', 'x.lrc', 'x.cue', 'rip.log', 'album.zip'].map(fileKind))
      .toEqual(['audio', 'audio', 'sidecar', 'sidecar', 'sidecar', 'sidecar', 'sidecar', 'archive'])
    expect(['notes.txt', 'back.jpg', 'cover.exe', 'setup.exe', 'noext'].map(fileKind)).toEqual([null, null, null, null, null])
  })

  it('normalizes safe paths and refuses unsafe ones', () => {
    expect(checkRelativePath('Album\\CD1//./01 Song.flac')).toEqual({ ok: true, path: 'Album/CD1/01 Song.flac', kind: 'audio' })
    for (const unsafe of ['/etc/passwd.flac', 'C:\\music\\a.flac', '../a.flac', 'Album/../../a.flac', 'a\u0000.flac', 'a\nb.flac', '..', '']) {
      expect(checkRelativePath(unsafe), unsafe).toEqual({ ok: false, reason: 'unsafe_path' })
    }
    expect(checkRelativePath(`${'d/'.repeat(8)}a.flac`).ok).toBe(false)
    expect(checkRelativePath(`${'x'.repeat(256)}.flac`).ok).toBe(false)
    expect(checkRelativePath('.DS_Store')).toEqual({ ok: false, reason: 'hidden' })
    expect(checkRelativePath('__MACOSX/Album/._01.flac')).toEqual({ ok: false, reason: 'hidden' })
    expect(checkRelativePath('Album/notes.txt')).toEqual({ ok: false, reason: 'unsupported_type' })
  })
})

describe('zip archives', () => {
  let dir = ''
  const zip = (name: string, entries: Parameters<typeof writeZip>[1]) => writeZip(path.join(dir, name), entries)
  const tree = async (root: string): Promise<string[]> => (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))).sort()

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'squirmy-zip-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('drops the single top-level folder and skips what is not music', async () => {
    const archive = await zip('album.zip', [
      { name: 'Album/' },
      { name: 'Album/01 One.flac', data: Buffer.from('one') },
      { name: 'Album/cover.jpg', data: Buffer.from('jpg') },
      { name: 'Album/notes.txt', data: Buffer.from('txt') },
      { name: 'Album/inner.zip', data: Buffer.from('zip') },
      { name: '__MACOSX/Album/._01 One.flac', data: Buffer.from('fork') },
    ])
    const plan = await inspectArchive(archive, limits)
    expect(plan).toMatchObject({ ok: true, folder: 'Album', skipped: 2 })
    const result = await extractArchive(archive, plan as Extract<typeof plan, { ok: true }>, path.join(dir, 'out-album'))
    expect(result).toEqual({ ok: true, extracted: 2, duplicates: 0 })
    expect(await tree(path.join(dir, 'out-album'))).toEqual(['01 One.flac', 'cover.jpg'])
    expect(await readFile(path.join(dir, 'out-album/01 One.flac'), 'utf8')).toBe('one')
  })

  it('names loose entries after the archive', async () => {
    const plan = await inspectArchive(await zip('Loose Tracks.zip', [{ name: 'a.flac', data: Buffer.from('a') }, { name: 'b/c.mp3', data: Buffer.from('c') }]), limits)
    expect(plan).toMatchObject({ ok: true, folder: 'Loose Tracks' })
  })

  it('refuses a whole archive with a traversal, absolute or control-character path', async () => {
    for (const [file, name] of [['up.zip', '../escape.flac'], ['deep.zip', 'Album/../../escape.flac'], ['abs.zip', '/tmp/escape.flac'], ['ctl.zip', 'Album/bad\u0001.flac'], ['back.zip', '..\\escape.flac']] as const) {
      const archive = await zip(file, [{ name: 'Album/01 Fine.flac', data: Buffer.from('fine') }, { name, data: Buffer.from('evil') }])
      expect(await inspectArchive(archive, limits), name).toEqual({ ok: false, reason: 'unsafe_archive' })
    }
  })

  it('refuses symbolic links', async () => {
    const archive = await zip('link.zip', [{ name: 'Album/01.flac', data: Buffer.from('x') }, { name: 'Album/02.flac', symlink: '/etc/passwd' }])
    expect(await inspectArchive(archive, limits)).toEqual({ ok: false, reason: 'unsafe_archive' })
  })

  it('refuses archives past the entry, size and total limits, and ones whose sizes lie', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024)
    expect(await inspectArchive(await zip('one-big.zip', [{ name: 'a.flac', data: big }]), limits)).toEqual({ ok: false, reason: 'unsafe_archive' })
    const many = Array.from({ length: 101 }, (_, index) => ({ name: `${index}.flac`, data: Buffer.from('x') }))
    expect(await inspectArchive(await zip('many.zip', many), limits)).toEqual({ ok: false, reason: 'unsafe_archive' })
    // A zip bomb: a few kilobytes that inflate past the total.
    const bomb = Array.from({ length: 5 }, (_, index) => ({ name: `${index}.flac`, data: Buffer.alloc(1024 * 1024) }))
    expect(await inspectArchive(await zip('bomb.zip', bomb), limits)).toEqual({ ok: false, reason: 'unsafe_archive' })

    // One that claims to be small and inflates far past it is stopped while extracting.
    const liar = await zip('liar.zip', [{ name: 'a.flac', data: Buffer.alloc(3 * 1024 * 1024), declaredSize: 10 }])
    const plan = await inspectArchive(liar, limits)
    expect(plan.ok).toBe(true)
    expect(await extractArchive(liar, plan as Extract<typeof plan, { ok: true }>, path.join(dir, 'out-liar'))).toEqual({ ok: false, reason: 'unsafe_archive' })
  })

  it('reports damaged archives', async () => {
    const damaged = path.join(dir, 'damaged.zip')
    await writeFile(damaged, 'PK not really a zip')
    expect(await inspectArchive(damaged, limits)).toEqual({ ok: false, reason: 'unreadable_archive' })
  })
})
