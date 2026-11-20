import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, organizeBatches } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { createArtist } from '../../test/factories.js'
import { getBatch } from './batches.js'
import { planOrganize } from './plan.js'
import { foldPath, MAX_COMPONENT_BYTES, resolveInRoot, sanitizeComponent } from './template.js'
import { addAlbum, addFileRow, makeRoot, manifest, movesOf, writeFixture } from './test-library.js'

describe('organize: planning', () => {
  useTestDatabase()

  const plan = async (rootId: string, options: Partial<Parameters<typeof planOrganize>[0]> = {}) => {
    const batchId = await planOrganize({ rootId, userId: null, ...options })
    const moves = await movesOf(batchId)
    return { batchId, moves, byFrom: new Map(moves.map((move) => [move.fromRelPath, move])) }
  }

  describe('planOrganize', () => {
    it('names files from the catalog, not from their tags', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'Real Artist' })
      await addAlbum(root, { artist, title: 'Real Album', year: 1999, tracks: [{ title: 'First' }, { title: 'Second' }] },
        ['junk/a.flac', 'junk/b.flac'], { tags: { title: 'wrong', artist: 'wrong', album: 'wrong' } })

      const { moves, batchId } = await plan(root.id)
      expect(moves.map((move) => [move.fromRelPath, move.toRelPath, move.status, move.kind])).toEqual([
        ['junk/a.flac', 'Real Artist/Real Album (1999)/01 First.flac', 'planned', 'audio'],
        ['junk/b.flac', 'Real Artist/Real Album (1999)/02 Second.flac', 'planned', 'audio'],
      ])
      const [batch] = await db.select().from(organizeBatches).where(eq(organizeBatches.id, batchId))
      expect(batch?.status).toBe('planned')
    })

    it('refuses read-only roots and invalid templates', async () => {
      const readOnly = await makeRoot('read_only')
      await expect(planOrganize({ rootId: readOnly.id, userId: null })).rejects.toMatchObject({ code: 'root_not_managed' })
      const broken = await makeRoot('managed', '{album}/{nope}.{ext}')
      await expect(planOrganize({ rootId: broken.id, userId: null })).rejects.toMatchObject({ code: 'invalid_template' })
    })

    it('leaves files waiting in _Incoming alone unless asked', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'Imported' })
      await addAlbum(root, { artist, title: 'Waiting', tracks: [{ title: 'T' }] }, ['_Incoming/0190aaaa-0000-7000-8000-000000000000/t.flac'])
      expect((await plan(root.id)).moves).toEqual([])
      expect((await plan(root.id, { includeIncoming: true })).moves.map((move) => move.toRelPath)).toEqual(['Imported/Waiting (2024)/01 T.flac'])
    })

    it('uses the root template', async () => {
      const root = await makeRoot('managed', '{albumartist} - {album}/{track}. {title}.{ext}')
      const artist = await createArtist({ name: 'X' })
      await addAlbum(root, { artist, title: 'Y', tracks: [{ title: 'Z' }] }, ['in/z.flac'])
      expect((await plan(root.id)).moves[0]?.toRelPath).toBe('X - Y/01. Z.flac')
    })

    it('only moves trusted, present files unless asked to include unmatched ones', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'A' })
      await addAlbum(root, { artist, title: 'Matched', tracks: [{ title: 'T' }] }, ['m/t.flac'])
      await addAlbum(root, { artist, title: 'Review', tracks: [{ title: 'T' }] }, ['r/t.flac'], { matchStatus: 'review' })
      const locked = await addAlbum(root, { artist, title: 'Locked', tracks: [{ title: 'T' }] }, ['l/t.flac'], { matchStatus: 'unmatched' })
      await db.execute(`update media_files set match_locked = true where id = '${locked.fileIds[0]}'`)
      await writeFixture(root.path, 'loose/x.mp3')
      await addFileRow(root.id, root.path, 'loose/x.mp3', { tags: { artist: 'Tag Artist', album: 'Tag Album', title: 'Tag Title', track: 3, year: 2001 } })
      await addFileRow(root.id, root.path, 'gone/y.flac', { link: null, missing: true })

      const strict = await plan(root.id)
      expect(strict.moves.map((move) => move.fromRelPath).sort()).toEqual(['l/t.flac', 'm/t.flac'])
      const [batch] = await db.select().from(organizeBatches).where(eq(organizeBatches.id, strict.batchId))
      expect(batch?.stats).toMatchObject({ untrusted: 2 })

      const loose = await plan(root.id, { includeUnmatched: true })
      expect(loose.byFrom.get('loose/x.mp3')?.toRelPath).toBe('Tag Artist/Tag Album (2001)/03 Tag Title.mp3')
      expect(loose.byFrom.get('r/t.flac')?.toRelPath).toBe('Unknown Artist/Unknown Album/t.flac')
      expect(loose.byFrom.has('gone/y.flac')).toBe(false)
    })

    it('handles unknown years, multi-disc releases and compilations', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'Band' })
      const noYear = await addAlbum(root, { artist, title: 'No Year', tracks: [{ title: 'A' }] }, ['1/a.flac'])
      await db.update(albums).set({ year: null }).where(eq(albums.id, noYear.albumId))
      await addAlbum(root, { artist, title: 'Double', year: 2010, tracks: [{ title: 'A', disc: 1 }, { title: 'B', disc: 2 }] }, ['2/a.flac', '2/b.flac'])
      await addAlbum(root, { artist: await createArtist({ name: 'Various Artists' }), title: 'Hits', year: 2000, tracks: [{ title: 'Hit' }] }, ['3/hit.flac'])
      await addAlbum(root, { artist, title: 'Comp', year: 2001, type: 'compilation', tracks: [{ title: 'C' }] }, ['4/c.flac'])
      const { byFrom } = await plan(root.id)
      expect(byFrom.get('1/a.flac')?.toRelPath).toBe('Band/No Year/01 A.flac')
      expect(byFrom.get('2/a.flac')?.toRelPath).toBe('Band/Double (2010)/1-01 A.flac')
      expect(byFrom.get('2/b.flac')?.toRelPath).toBe('Band/Double (2010)/2-01 B.flac')
      expect(byFrom.get('3/hit.flac')?.toRelPath).toBe('Various Artists/Hits (2000)/01 Hit.flac')
      expect(byFrom.get('4/c.flac')?.toRelPath).toBe('Various Artists/Comp (2001)/01 C.flac')
    })

    it('pads track numbers to the size of the release', async () => {
      const root = await makeRoot()
      const tracks = Array.from({ length: 101 }, (_, index) => ({ title: `T${index + 1}` }))
      const paths = tracks.map((_, index) => index === 0 || index === 100 ? `in/${index}.flac` : '')
      await addAlbum(root, { artist: await createArtist({ name: 'P' }), title: 'Long', year: 2000, tracks }, paths)
      const planned = await plan(root.id)
      expect(planned.byFrom.get('in/0.flac')?.toRelPath).toBe('P/Long (2000)/001 T1.flac')
      expect(planned.byFrom.get('in/100.flac')?.toRelPath).toBe('P/Long (2000)/101 T101.flac')
    })

    it('leaves files that are already in place, unless tags are to be written', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'Here' })
      await addAlbum(root, { artist, title: 'Done', year: 2000, tracks: [{ title: 'A' }, { title: 'B' }] }, ['Here/Done (2000)/01 A.flac', 'x/b.flac'])
      const plain = await plan(root.id)
      expect(plain.moves.map((move) => move.fromRelPath)).toEqual(['x/b.flac'])
      const [batch] = await db.select().from(organizeBatches).where(eq(organizeBatches.id, plain.batchId))
      expect(batch?.stats).toMatchObject({ unchanged: 1 })

      const withTags = await plan(root.id, { writeTags: true })
      expect(withTags.byFrom.get('Here/Done (2000)/01 A.flac')).toMatchObject({ toRelPath: 'Here/Done (2000)/01 A.flac', status: 'planned' })
    })

    it('filters by album', async () => {
      const root = await makeRoot()
      const artist = await createArtist()
      const one = await addAlbum(root, { artist, title: 'One', tracks: [{ title: 'A' }] }, ['a/1.flac'])
      await addAlbum(root, { artist, title: 'Two', tracks: [{ title: 'A' }] }, ['b/1.flac'])
      const { moves } = await plan(root.id, { albumIds: [one.albumId] })
      expect(moves.map((move) => move.fromRelPath)).toEqual(['a/1.flac'])
    })

    it('touches nothing on disk', async () => {
      const root = await makeRoot()
      await addAlbum(root, { title: 'Album', tracks: [{ title: 'A' }, { title: 'B' }] }, ['in/a.flac', 'in/b.flac'])
      await writeFixture(root.path, 'in/cover.jpg')
      const before = await manifest(root.path)
      await plan(root.id)
      expect(await manifest(root.path)).toEqual(before)
    })
  })

  describe('collisions', () => {
    it('gives files with the same target a deterministic suffix', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'Dup' })
      await addAlbum(root, { artist, title: 'Same', year: 2000, tracks: [{ title: 'Song' }] }, ['b/song.flac'])
      await addAlbum(root, { artist, title: 'Same', year: 2000, tracks: [{ title: 'Song' }] }, ['a/song.flac'])
      await addAlbum(root, { artist, title: 'Same', year: 2000, tracks: [{ title: 'SONG' }] }, ['c/song.flac'])
      const { byFrom } = await plan(root.id)
      expect(byFrom.get('a/song.flac')?.toRelPath).toBe('Dup/Same (2000)/01 Song.flac')
      expect(byFrom.get('b/song.flac')?.toRelPath).toBe('Dup/Same (2000)/01 Song (2).flac')
      expect(byFrom.get('c/song.flac')?.toRelPath).toBe('Dup/Same (2000)/01 SONG (3).flac')
    })

    it('lets the file already at a target keep it', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'K' })
      await addAlbum(root, { artist, title: 'Keep', year: 2000, tracks: [{ title: 'T' }] }, ['a/t.flac'])
      await addAlbum(root, { artist, title: 'Keep', year: 2000, tracks: [{ title: 'T' }] }, ['K/Keep (2000)/01 T.flac'])
      const { byFrom } = await plan(root.id)
      expect(byFrom.get('a/t.flac')?.toRelPath).toBe('K/Keep (2000)/01 T (2).flac')
      expect(byFrom.has('K/Keep (2000)/01 T.flac')).toBe(false)
    })

    it('skips a target held by a file outside the batch, on disk or in the library', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'Occ' })
      await addAlbum(root, { artist, title: 'Disk', year: 2000, tracks: [{ title: 'A' }] }, ['in/a.flac'])
      await writeFixture(root.path, 'Occ/Disk (2000)/01 a.flac')
      await addAlbum(root, { artist, title: 'Row', year: 2000, tracks: [{ title: 'A' }] }, ['in2/a.flac'])
      await addFileRow(root.id, root.path, 'Occ/Row (2000)/01 A.flac', { missing: true })
      const { byFrom } = await plan(root.id)
      expect(byFrom.get('in/a.flac')).toMatchObject({ status: 'skipped', error: 'The destination is already taken by another file' })
      expect(byFrom.get('in2/a.flac')).toMatchObject({ status: 'skipped', error: 'The destination is already taken by a missing library file' })
    })

    it('reuses the spelling of a folder that already exists', async () => {
      const root = await makeRoot()
      await mkdir(path.join(root.path, 'the band', 'old'), { recursive: true })
      await writeFixture(root.path, 'the band/old/keep.txt')
      const artist = await createArtist({ name: 'The Band' })
      await addAlbum(root, { artist, title: 'Rec', year: 2000, tracks: [{ title: 'A' }] }, ['in/a.flac'])
      const { moves } = await plan(root.id)
      expect(moves[0]?.toRelPath).toBe('the band/Rec (2000)/01 A.flac')
    })

    it('orders a move after the move that vacates its target, and skips swaps', async () => {
      const root = await makeRoot('managed', '{title}.{ext}')
      const artist = await createArtist()
      // "B.flac" must move to "C.flac" before "A.flac" can become "B.flac".
      await addAlbum(root, { artist, title: 'Chain', tracks: [{ title: 'B' }, { title: 'C' }] }, ['A.flac', 'B.flac'])
      await addAlbum(root, { artist, title: 'Swap', tracks: [{ title: 'Y' }, { title: 'X' }] }, ['X.flac', 'Y.flac'])
      const { moves } = await plan(root.id)
      const planned = moves.filter((move) => move.status === 'planned').map((move) => `${move.fromRelPath}>${move.toRelPath}`)
      expect(planned).toEqual(['B.flac>C.flac', 'A.flac>B.flac'])
      expect(moves.filter((move) => move.status === 'skipped').map((move) => move.fromRelPath).sort()).toEqual(['X.flac', 'Y.flac'])
    })
  })

  describe('sidecars', () => {
    it('travel with a folder whose audio all moves to one place, .lrc files renamed to follow', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'S' })
      await addAlbum(root, { artist, title: 'Side', year: 2000, tracks: [{ title: 'One' }, { title: 'Two' }] }, ['rip/a.flac', 'rip/b.flac'])
      for (const name of ['cover.jpg', 'a.lrc', 'notes.lrc', 'rip.cue', 'rip.log', 'info.txt', 'booklet.pdf', 'list.m3u', '.DS_Store', '._cover.jpg', 'video.mkv']) {
        await writeFixture(root.path, `rip/${name}`)
      }
      const { moves, batchId } = await plan(root.id)
      const sidecars = moves.filter((move) => move.kind === 'sidecar').map((move) => [move.fromRelPath, move.toRelPath])
      expect(sidecars.sort()).toEqual([
        ['rip/a.lrc', 'S/Side (2000)/01 One.lrc'],
        ['rip/booklet.pdf', 'S/Side (2000)/booklet.pdf'],
        ['rip/cover.jpg', 'S/Side (2000)/cover.jpg'],
        ['rip/info.txt', 'S/Side (2000)/info.txt'],
        ['rip/list.m3u', 'S/Side (2000)/list.m3u'],
        ['rip/notes.lrc', 'S/Side (2000)/notes.lrc'],
        ['rip/rip.cue', 'S/Side (2000)/rip.cue'],
        ['rip/rip.log', 'S/Side (2000)/rip.log'],
      ])
      const view = await getBatch(batchId)
      expect(view.albums).toHaveLength(1)
      expect(view.albums[0]?.moves).toHaveLength(10)
    })

    it('stay when an audio file stays behind, or the folder splits', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'S' })
      await addAlbum(root, { artist, title: 'Partial', tracks: [{ title: 'One' }] }, ['partial/a.flac'])
      await writeFixture(root.path, 'partial/unknown.mp3')
      await writeFixture(root.path, 'partial/cover.jpg')
      await addAlbum(root, { artist, title: 'Split1', tracks: [{ title: 'One' }] }, ['split/a.flac'])
      await addAlbum(root, { artist, title: 'Split2', tracks: [{ title: 'One' }] }, ['split/b.flac'])
      await writeFixture(root.path, 'split/cover.jpg')
      await addAlbum(root, { artist, title: 'Untrusted', tracks: [{ title: 'One' }, { title: 'Two' }] }, ['mixed/a.flac'])
      await writeFixture(root.path, 'mixed/b.flac')
      await addFileRow(root.id, root.path, 'mixed/b.flac')
      await writeFixture(root.path, 'mixed/cover.jpg')
      const { moves } = await plan(root.id)
      expect(moves.filter((move) => move.kind === 'sidecar')).toEqual([])
    })

    it('skip a destination that is taken', async () => {
      const root = await makeRoot()
      const artist = await createArtist({ name: 'S' })
      await addAlbum(root, { artist, title: 'Taken', year: 2000, tracks: [{ title: 'One' }] }, ['in/a.flac'])
      await writeFixture(root.path, 'in/cover.jpg')
      await mkdir(path.join(root.path, 'S/Taken (2000)'), { recursive: true })
      await writeFile(path.join(root.path, 'S/Taken (2000)/Cover.JPG'), 'existing')
      const { moves } = await plan(root.id)
      expect(moves.find((move) => move.kind === 'sidecar')).toMatchObject({ status: 'skipped', fromRelPath: 'in/cover.jpg' })
    })
  })

  describe('property: random libraries', () => {
    // Deterministic pseudo-random numbers, so a failure reproduces.
    const random = (seed: number) => () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed / 2 ** 31
    }
    const pieces = [
      'a', 'Z', ' ', '  ', '.', '..', '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\u0001', '\u001f', '\n', '\t', 'é', 'é', 'É', '日本',
      '😀', '👩‍👩‍👧', 'CON', 'nul', 'Com1', 'ß', 'SS', 'ss', '-', '(', ')', '[', ']', '{title}', '%', '​', 'x'.repeat(120), '語'.repeat(50),
    ]

    it('always plans unique, sanitized targets inside the root', async () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const next = random(seed)
        const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!
        const text = () => Array.from({ length: 1 + Math.floor(next() * 6) }, () => pick(pieces)).join('')
        const root = await makeRoot()
        const artists = [await createArtist({ name: text() }), await createArtist({ name: text() }), await createArtist({ name: text().toUpperCase() })]
        for (let album = 0; album < 4; album += 1) {
          const tracks = Array.from({ length: 1 + Math.floor(next() * 5) }, () => ({ title: pick([text(), 'Same Title', 'same title']), disc: pick([1, 1, 2]) }))
          const folder = `in${seed}-${album}`
          await addAlbum(root, { artist: pick(artists), title: pick([text(), 'Same Album']), year: pick([1990, 2000]), tracks },
            tracks.map((_, index) => `${folder}/${index}.${pick(['flac', 'mp3', 'M4A'])}`))
        }
        const { moves } = await plan(root.id)
        const targets = moves.filter((move) => move.status === 'planned').map((move) => move.toRelPath)
        expect(targets.length).toBeGreaterThan(0)
        expect(new Set(targets.map(foldPath)).size).toBe(targets.length)
        for (const target of targets) {
          expect(() => resolveInRoot(root.path, target)).not.toThrow()
          for (const component of target.split('/')) {
            expect(component.length).toBeGreaterThan(0)
            expect(sanitizeComponent(component)).toBe(component)
            expect(Buffer.byteLength(component)).toBeLessThanOrEqual(MAX_COMPONENT_BYTES)
          }
          expect(target).toMatch(/\.(flac|mp3|m4a)$/)
        }
      }
    })
  })
})
