import { copyFile, link, mkdir, readdir, rename, unlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { fileMoves, libraryRoots, organizeBatches } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { createArtist } from '../../test/factories.js'
import { applyBatch, moveTempPath } from './apply.js'
import { getBatch } from './batches.js'
import { realFileOps, type FileOps } from './files.js'
import { withRootLock } from './journal.js'
import { planOrganize } from './plan.js'
import { revertBatch } from './revert.js'
import { addAlbum, makeRoot, manifest, movesOf, relPathOf, writeFixture } from '../../test/organize-library.js'

describe('organize: apply and revert', () => {
  useTestDatabase()

  const exdev = () => Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
  /** Behaves as if every source were on another file system than its destination; the temp copy is on the destination's. */
  const sameDevice = (from: string) => path.basename(from).startsWith('.squirmy-move-')
  const crossDevice: FileOps = {
    ...realFileOps,
    link: async (from, to) => (sameDevice(from) ? realFileOps.link(from, to) : Promise.reject(exdev())),
    rename: async (from, to) => (sameDevice(from) ? realFileOps.rename(from, to) : Promise.reject(exdev())),
  }

  const batchStatus = async (batchId: string) =>
    (await db.select({ status: organizeBatches.status }).from(organizeBatches).where(eq(organizeBatches.id, batchId)))[0]?.status

  /** A messy album folder with sidecars, a nested disc folder and an unrelated file. */
  async function messyLibrary() {
    const root = await makeRoot()
    const artist = await createArtist({ name: 'Artist' })
    const album = await addAlbum(root, { artist, title: 'Album', year: 2001, tracks: [{ title: 'One' }, { title: 'Two' }, { title: 'Three', disc: 2 }] },
      ['Downloads/rip/CD1/one.flac', 'Downloads/rip/CD1/two.flac', 'Downloads/rip/CD2/three.flac'])
    await writeFixture(root.path, 'Downloads/rip/CD1/cover.jpg')
    await writeFixture(root.path, 'Downloads/rip/CD1/one.lrc')
    await writeFixture(root.path, 'Downloads/rip/CD2/disc.cue')
    await writeFixture(root.path, 'Unrelated/readme.txt')
    return { root, album }
  }

  describe('apply and revert', () => {
    it('moves files and sidecars, and undo restores a byte-identical tree', async () => {
      const { root, album } = await messyLibrary()
      const before = await manifest(root.path)
      const batchId = await planOrganize({ rootId: root.id, userId: null })

      await applyBatch(batchId)
      expect(await batchStatus(batchId)).toBe('applied')
      expect(await manifest(root.path)).toEqual({
        'Artist/': 'dir',
        'Artist/Album (2001)/': 'dir',
        'Artist/Album (2001)/1-01 One.flac': before['Downloads/rip/CD1/one.flac'],
        'Artist/Album (2001)/1-02 Two.flac': before['Downloads/rip/CD1/two.flac'],
        'Artist/Album (2001)/2-01 Three.flac': before['Downloads/rip/CD2/three.flac'],
        'Artist/Album (2001)/cover.jpg': before['Downloads/rip/CD1/cover.jpg'],
        'Artist/Album (2001)/1-01 One.lrc': before['Downloads/rip/CD1/one.lrc'],
        'Artist/Album (2001)/disc.cue': before['Downloads/rip/CD2/disc.cue'],
        'Unrelated/': 'dir',
        'Unrelated/readme.txt': before['Unrelated/readme.txt'],
      })
      expect(await relPathOf(album.fileIds[0]!)).toBe('Artist/Album (2001)/1-01 One.flac')
      const view = await getBatch(batchId)
      expect(view.counts).toMatchObject({ applied: 6, sidecars: 3, failed: 0 })
      expect(view.notice).toBeNull()

      await revertBatch(batchId)
      expect(await batchStatus(batchId)).toBe('reverted')
      expect(await manifest(root.path)).toEqual(before)
      expect(await relPathOf(album.fileIds[0]!)).toBe('Downloads/rip/CD1/one.flac')
      expect((await getBatch(batchId)).counts).toMatchObject({ applied: 0, reverted: 6, notReverted: 0 })
      const directories = (await movesOf(batchId)).filter((move) => move.kind === 'directory')
      expect(directories.map((move) => [move.fromRelPath, move.toRelPath, move.status]).sort()).toEqual([
        ['', 'Artist', 'reverted'],
        ['', 'Artist/Album (2001)', 'reverted'],
        ['Downloads', '', 'reverted'],
        ['Downloads/rip', '', 'reverted'],
        ['Downloads/rip/CD1', '', 'reverted'],
        ['Downloads/rip/CD2', '', 'reverted'],
      ])
    })

    it('falls back to copy, verify and delete across file systems', async () => {
      const { root } = await messyLibrary()
      const before = await manifest(root.path)
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await applyBatch(batchId, { ops: crossDevice })
      const after = await manifest(root.path)
      expect(after['Artist/Album (2001)/1-01 One.flac']).toBe(before['Downloads/rip/CD1/one.flac'])
      expect(Object.keys(after).some((file) => file.includes('.squirmy-'))).toBe(false)
      expect(Object.keys(after).some((file) => file.startsWith('Downloads'))).toBe(false)
      await revertBatch(batchId, { ops: crossDevice })
      expect(await manifest(root.path)).toEqual(before)
    })

    it('keeps the original when a cross-device copy does not verify', async () => {
      const { root } = await messyLibrary()
      const before = await manifest(root.path)
      const corrupting: FileOps = {
        ...crossDevice,
        copyFile: async (from, to, mode) => {
          await copyFile(from, to, mode)
          await writeFile(to, 'corrupted', { flag: 'r+' })
        },
      }
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await applyBatch(batchId, { ops: corrupting })
      expect(await batchStatus(batchId)).toBe('failed')
      const moves = await movesOf(batchId)
      expect(moves.filter((move) => move.kind === 'audio').every((move) => move.status === 'failed')).toBe(true)
      expect(moves.filter((move) => move.kind === 'sidecar').every((move) => move.status === 'skipped')).toBe(true)
      expect(moves.find((move) => move.kind === 'audio')?.error).toBe('The copy did not match the original; the original was left in place')
      // The folders created for the failed moves are gone again.
      expect(await manifest(root.path)).toEqual(before)
    })

    it('uses rename where hard links are not supported', async () => {
      const { root } = await messyLibrary()
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      const noLinks: FileOps = { ...realFileOps, link: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTSUP' }) } }
      await applyBatch(batchId, { ops: noLinks })
      expect((await getBatch(batchId)).counts).toMatchObject({ applied: 6, failed: 0 })
    })

    it('never overwrites a file that appears at a destination after planning', async () => {
      const { root } = await messyLibrary()
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await writeFixture(root.path, 'Artist/Album (2001)/1-02 Two.flac')
      const intruder = (await manifest(root.path))['Artist/Album (2001)/1-02 Two.flac']
      const source = (await manifest(root.path))['Downloads/rip/CD1/two.flac']

      await applyBatch(batchId)
      const after = await manifest(root.path)
      expect(after['Artist/Album (2001)/1-02 Two.flac']).toBe(intruder)
      expect(after['Downloads/rip/CD1/two.flac']).toBe(source)
      const failed = (await movesOf(batchId)).filter((move) => move.status === 'failed')
      expect(failed.map((move) => [move.fromRelPath, move.error])).toEqual([
        ['Downloads/rip/CD1/two.flac', 'Something already exists at the destination; nothing was overwritten'],
      ])
      // The folder still holds an audio file, so it keeps its sidecars; the batch is still applied.
      expect(await batchStatus(batchId)).toBe('applied')
      expect(after['Downloads/rip/CD1/cover.jpg']).toBeDefined()
      expect(after['Downloads/rip/CD1/one.lrc']).toBeDefined()
      expect(after['Artist/Album (2001)/disc.cue']).toBeDefined()
      expect((await movesOf(batchId)).find((move) => move.fromRelPath.endsWith('cover.jpg'))).toMatchObject({ status: 'skipped', error: 'An audio file in its folder did not move' })
    })

    it('records a failed move and carries on', async () => {
      const { root } = await messyLibrary()
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await unlink(path.join(root.path, 'Downloads/rip/CD1/two.flac'))
      await applyBatch(batchId)
      const moves = await movesOf(batchId)
      expect(moves.find((move) => move.fromRelPath.endsWith('two.flac'))).toMatchObject({ status: 'failed', error: 'The file is no longer there' })
      expect(moves.find((move) => move.fromRelPath.endsWith('three.flac'))?.status).toBe('applied')
      expect(await batchStatus(batchId)).toBe('applied')
    })

    it('refuses a root that is no longer managed', async () => {
      const { root } = await messyLibrary()
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await db.update(libraryRoots).set({ mode: 'read_only' }).where(eq(libraryRoots.id, root.id))
      await expect(applyBatch(batchId)).rejects.toMatchObject({ code: 'root_not_managed' })
    })

    it('runs one batch per root at a time', async () => {
      const { root } = await messyLibrary()
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await withRootLock(root.id, async () => {
        await expect(applyBatch(batchId)).rejects.toMatchObject({ code: 'organize_busy' })
      })
      await applyBatch(batchId)
      expect(await batchStatus(batchId)).toBe('applied')
    })

    it('renames a file whose name only changes case', async () => {
      const root = await makeRoot('managed', '{title}.{ext}')
      const album = await addAlbum(root, { title: 'Case', tracks: [{ title: 'Hello' }] }, ['hello.flac'])
      const before = await manifest(root.path)
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await applyBatch(batchId)
      expect(await readdir(root.path)).toEqual(['Hello.flac'])
      expect(await relPathOf(album.fileIds[0]!)).toBe('Hello.flac')
      await revertBatch(batchId)
      expect(await manifest(root.path)).toEqual(before)
    })
  })

  describe('undo safety', () => {
    it('leaves files that changed or moved since, and still finishes', async () => {
      const { root, album } = await messyLibrary()
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await applyBatch(batchId)

      const changed = path.join(root.path, 'Artist/Album (2001)/1-01 One.flac')
      await writeFile(changed, 'edited by someone', { flag: 'a' })
      const future = new Date(Date.now() + 60_000)
      await utimes(changed, future, future)
      await rename(path.join(root.path, 'Artist/Album (2001)/cover.jpg'), path.join(root.path, 'Unrelated/cover.jpg'))

      await revertBatch(batchId)
      expect(await batchStatus(batchId)).toBe('reverted')
      const moves = await movesOf(batchId)
      expect(moves.find((move) => move.toRelPath.endsWith('1-01 One.flac'))).toMatchObject({ status: 'applied', error: 'Not undone: The file has changed since the batch was applied' })
      expect(moves.find((move) => move.toRelPath.endsWith('cover.jpg'))).toMatchObject({ status: 'applied', error: 'Not undone: The file is no longer there' })
      expect(await relPathOf(album.fileIds[0]!)).toBe('Artist/Album (2001)/1-01 One.flac')
      expect(await relPathOf(album.fileIds[1]!)).toBe('Downloads/rip/CD1/two.flac')
      const tree = await manifest(root.path)
      expect(tree['Artist/Album (2001)/1-01 One.flac']).toBeDefined()
      expect(tree['Downloads/rip/CD1/two.flac']).toBeDefined()
      expect((await getBatch(batchId)).counts).toMatchObject({ notReverted: 2, reverted: 4 })
    })

    it('refuses batches that were never applied', async () => {
      const { root } = await messyLibrary()
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await expect(revertBatch(batchId)).rejects.toMatchObject({ code: 'batch_not_applied' })
    })
  })

  describe('crash recovery', () => {
    /** Puts the batch in the state a process leaves behind when it dies mid-apply. */
    const interrupted = async (batchId: string) => db.update(organizeBatches).set({ status: 'applying' }).where(eq(organizeBatches.id, batchId))

    it('finishes a move whose file was moved but whose database row was not updated', async () => {
      const { root, album } = await messyLibrary()
      const before = await manifest(root.path)
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      const [first] = await movesOf(batchId)
      await mkdir(path.join(root.path, 'Artist/Album (2001)'), { recursive: true })
      await rename(path.join(root.path, first!.fromRelPath), path.join(root.path, first!.toRelPath))
      await interrupted(batchId)

      await applyBatch(batchId)
      expect(await batchStatus(batchId)).toBe('applied')
      expect((await movesOf(batchId)).filter((move) => move.kind !== 'directory').every((move) => move.status === 'applied')).toBe(true)
      expect(await relPathOf(album.fileIds[0]!)).toBe(first!.toRelPath)
      await revertBatch(batchId)
      // The directories made "by hand" above were not journaled, so only they remain.
      const after = await manifest(root.path)
      delete after['Artist/']
      delete after['Artist/Album (2001)/']
      expect(after).toEqual(before)
    })

    it('finishes a move that stopped between linking and unlinking', async () => {
      const { root } = await messyLibrary()
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      const [first] = await movesOf(batchId)
      await mkdir(path.join(root.path, 'Artist/Album (2001)'), { recursive: true })
      await link(path.join(root.path, first!.fromRelPath), path.join(root.path, first!.toRelPath))
      await interrupted(batchId)
      await applyBatch(batchId)
      const tree = await manifest(root.path)
      expect(tree[first!.fromRelPath]).toBeUndefined()
      expect(tree[first!.toRelPath]).toBeDefined()
    })

    it('discards a half-written cross-device copy and starts over', async () => {
      const { root } = await messyLibrary()
      const before = await manifest(root.path)
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      const [first] = await movesOf(batchId)
      const target = path.join(root.path, first!.toRelPath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(moveTempPath(target, first!.id), 'partial')
      await interrupted(batchId)
      await applyBatch(batchId, { ops: crossDevice })
      const after = await manifest(root.path)
      expect(after[first!.toRelPath]).toBe(before[first!.fromRelPath])
      expect(Object.keys(after).some((file) => file.includes('.squirmy-'))).toBe(false)
    })

    it('deletes the source of a finished cross-device copy only when the copy is identical', async () => {
      const { root } = await messyLibrary()
      const before = await manifest(root.path)
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      const [first, second] = await movesOf(batchId)
      await mkdir(path.join(root.path, 'Artist/Album (2001)'), { recursive: true })
      // The first copy finished; the second "copy" differs, so it is not ours to trust.
      await copyFile(path.join(root.path, first!.fromRelPath), path.join(root.path, first!.toRelPath))
      await writeFile(path.join(root.path, second!.toRelPath), 'something else')
      await interrupted(batchId)
      await applyBatch(batchId, { ops: crossDevice })
      const after = await manifest(root.path)
      expect(after[first!.fromRelPath]).toBeUndefined()
      expect(after[first!.toRelPath]).toBe(before[first!.fromRelPath])
      expect(after[second!.fromRelPath]).toBe(before[second!.fromRelPath])
      expect((await movesOf(batchId)).find((move) => move.id === second!.id)?.status).toBe('failed')
    })

    it('finishes an undo whose file was moved back but whose database row was not updated', async () => {
      const { root, album } = await messyLibrary()
      const before = await manifest(root.path)
      const batchId = await planOrganize({ rootId: root.id, userId: null })
      await applyBatch(batchId)
      const moves = (await movesOf(batchId)).filter((move) => move.kind === 'audio')
      const last = moves[moves.length - 1]!
      await rename(path.join(root.path, last.toRelPath), path.join(root.path, last.fromRelPath)).catch(async () => {
        await mkdir(path.dirname(path.join(root.path, last.fromRelPath)), { recursive: true })
        await rename(path.join(root.path, last.toRelPath), path.join(root.path, last.fromRelPath))
      })
      await db.update(organizeBatches).set({ status: 'reverting' }).where(eq(organizeBatches.id, batchId))

      await revertBatch(batchId)
      expect(await batchStatus(batchId)).toBe('reverted')
      expect((await db.select().from(fileMoves).where(eq(fileMoves.id, last.id)))[0]?.status).toBe('reverted')
      expect(await relPathOf(album.fileIds[2]!)).toBe(last.fromRelPath)
      expect(await manifest(root.path)).toEqual(before)
    })
  })
})
