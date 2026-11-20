import path from 'node:path'
import { DEFAULT_ORGANIZE_TEMPLATE, INCOMING_FOLDER } from '@squirmy/contracts'
import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import {
  albums, fileMoves, libraryRoots, mediaFiles, organizeBatches, recordings, releaseTracks, type FileTags,
} from '../../database/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { matchKey } from '../../lib/text.js'
import { readdirOrEmpty } from './files.js'
import { assertManaged, type BatchOptions } from './journal.js'
import {
  fileName, foldPath, joinRendered, parseTemplate, renderTemplate, resolveInRoot, sanitizeExtension, TemplateError,
  type RenderedPath, type TemplateValues,
} from './template.js'

export type PlanOptions = {
  rootId: string
  /** Only files linked to these albums. */
  albumIds?: string[]
  /** Also file untrusted files, named from their tags. */
  includeUnmatched?: boolean
  /** Write catalog tags while applying. Files already in place are then planned as tag-only moves. */
  writeTags?: boolean
  /** Also plan files in the root's `_Incoming` folder, where imports wait until they are filed. */
  includeIncoming?: boolean
  userId: string | null
}

/** Extensions treated as audio when deciding whether a whole folder moves. */
const audioExtensions = new Set([
  'flac', 'mp3', 'm4a', 'm4b', 'mp4', 'aac', 'alac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff', 'wma', 'ape', 'wv', 'mpc', 'dsf', 'dff', 'tta',
])
/** Files that travel with their album when the whole folder moves. */
const sidecarExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'lrc', 'cue', 'log', 'txt', 'pdf', 'm3u', 'm3u8'])

const extensionOf = (name: string) => path.extname(name).slice(1).toLowerCase()

type Plan = {
  fileId: string | null
  kind: 'audio' | 'sidecar'
  from: string
  to: string
  rendered: RenderedPath | null
  status: 'planned' | 'skipped'
  reason: string | null
}

/**
 * Plans an organize batch for a managed root: where every trusted, present file should
 * live under the root's template, which sidecars travel with their folders, and which
 * files must stay because of a collision. Writes an `organize_batches` row and its
 * `file_moves` (in the order they must be applied) and returns the batch id. Reads
 * directories but changes nothing on disk.
 */
export async function planOrganize(options: PlanOptions): Promise<string> {
  const [root] = await db.select().from(libraryRoots).where(eq(libraryRoots.id, options.rootId))
  if (!root) throw notFound('Library root not found', 'root_not_found')
  assertManaged(root)
  const templateText = root.template ?? DEFAULT_ORGANIZE_TEMPLATE
  let template
  try {
    template = parseTemplate(templateText)
  } catch (error) {
    if (error instanceof TemplateError) throw badRequest(`The root's template is invalid: ${error.message}`, 'invalid_template')
    throw error
  }

  const files = await db.select({
    id: mediaFiles.id,
    relPath: mediaFiles.relPath,
    tags: mediaFiles.tags,
    matchStatus: mediaFiles.matchStatus,
    matchLocked: mediaFiles.matchLocked,
    releaseId: releaseTracks.releaseId,
    disc: releaseTracks.disc,
    position: releaseTracks.position,
    trackTitle: releaseTracks.title,
    trackCredit: releaseTracks.artistCredit,
    recordingCredit: recordings.artistCredit,
    album: { title: albums.title, artistCredit: albums.artistCredit, year: albums.year, type: albums.type, secondaryTypes: albums.secondaryTypes },
  }).from(mediaFiles)
    .leftJoin(releaseTracks, eq(releaseTracks.id, mediaFiles.releaseTrackId))
    .leftJoin(recordings, eq(recordings.id, releaseTracks.recordingId))
    .leftJoin(albums, eq(albums.id, mediaFiles.albumId))
    .where(and(
      eq(mediaFiles.rootId, root.id),
      isNull(mediaFiles.missingSince),
      options.albumIds ? inArray(mediaFiles.albumId, options.albumIds) : undefined,
      options.includeIncoming ? undefined : sql`not starts_with(${mediaFiles.relPath}, ${`${INCOMING_FOLDER}/`})`,
    ))
    .orderBy(mediaFiles.relPath)

  const releaseIds = [...new Set(files.flatMap((file) => file.releaseId ? [file.releaseId] : []))]
  const shapes = new Map<string, { discs: number; positions: number }>()
  for (const row of releaseIds.length === 0 ? [] : await db.select({
    releaseId: releaseTracks.releaseId, discs: max(releaseTracks.disc), positions: max(releaseTracks.position),
  }).from(releaseTracks).where(inArray(releaseTracks.releaseId, releaseIds)).groupBy(releaseTracks.releaseId)) {
    shapes.set(row.releaseId, { discs: row.discs ?? 1, positions: row.positions ?? 1 })
  }

  // Every row in the root, present or missing: a missing file's path is still taken in the database.
  const inRoot = await db.select({ id: mediaFiles.id, relPath: mediaFiles.relPath, missing: sql<boolean>`${mediaFiles.missingSince} is not null` })
    .from(mediaFiles).where(eq(mediaFiles.rootId, root.id))

  const disk = new DiskView(root.path)
  const directoryCase = new Map<string, string>()
  /** Uses the spelling of a directory that already exists or is already planned, so "abba" and "ABBA" share one folder. */
  const canonicalDirectories = async (directories: string[]) => {
    let parent = ''
    for (const name of directories) {
      const wanted = parent ? `${parent}/${name}` : name
      let actual = directoryCase.get(foldPath(wanted))
      if (!actual) {
        const existing = (await disk.list(parent)).find((entry) => entry.isDirectory() && foldPath(entry.name) === foldPath(name))
        actual = existing ? (parent ? `${parent}/${existing.name}` : existing.name) : wanted
        directoryCase.set(foldPath(wanted), actual)
      }
      parent = actual
    }
    return parent
  }

  let untrusted = 0
  const unchanged: string[] = []
  const audio: Plan[] = []
  for (const file of files) {
    const trusted = (file.matchStatus === 'matched' || file.matchLocked) && file.releaseId !== null && file.album !== null
    if (!trusted && !options.includeUnmatched) {
      untrusted += 1
      continue
    }
    const extension = path.extname(file.relPath)
    const values = trusted
      ? catalogValues(file as CatalogFile, shapes.get(file.releaseId!) ?? { discs: 1, positions: 1 }, extension)
      : tagValues(file.tags, file.relPath, extension)
    const rendered = renderTemplate(template, values)
    const directory = await canonicalDirectories(rendered.directories)
    const name = fileName(rendered.stem, rendered.extension)
    const to = directory ? `${directory}/${name}` : name
    if (to === file.relPath && !options.writeTags) {
      unchanged.push(to)
      continue
    }
    audio.push({ fileId: file.id, kind: 'audio', from: file.relPath, to, rendered: { ...rendered, directories: directory ? directory.split('/') : [] }, status: 'planned', reason: null })
  }

  const ordered = await resolveCollisions(audio, unchanged, inRoot, disk)
  const sidecars = await planSidecars(ordered.filter((move) => move.status === 'planned'), inRoot, disk, ordered)

  const batchId = newId()
  const batchOptions: BatchOptions = {
    ...(options.albumIds ? { albumIds: options.albumIds } : {}),
    includeUnmatched: options.includeUnmatched ?? false,
    writeTags: options.writeTags ?? false,
    template: templateText,
  }
  await db.transaction(async (tx) => {
    await tx.insert(organizeBatches).values({
      id: batchId, rootId: root.id, createdBy: options.userId, status: 'planned', options: batchOptions, stats: { unchanged: unchanged.length, untrusted },
    })
    // Ids are time ordered, so insertion order is the order apply runs the moves in.
    const rows = [...ordered, ...sidecars].map((move) => ({
      id: newId(), batchId, fileId: move.fileId, kind: move.kind, fromRelPath: move.from, toRelPath: move.to, status: move.status, error: move.reason,
    }))
    for (let index = 0; index < rows.length; index += 1000) await tx.insert(fileMoves).values(rows.slice(index, index + 1000))
  })
  return batchId
}

type CatalogFile = {
  relPath: string
  disc: number
  position: number
  trackTitle: string
  trackCredit: string | null
  recordingCredit: string | null
  album: { title: string; artistCredit: string; year: number | null; type: string; secondaryTypes: string[] }
}

const isCompilation = (album: CatalogFile['album']) =>
  album.type === 'compilation' || album.secondaryTypes.includes('compilation') || matchKey(album.artistCredit) === 'various artists'

/** Names from the catalog rows the file is linked to. */
function catalogValues(file: CatalogFile, shape: { discs: number; positions: number }, extension: string): TemplateValues {
  return {
    albumartist: isCompilation(file.album) ? 'Various Artists' : file.album.artistCredit,
    artist: file.trackCredit ?? file.recordingCredit ?? file.album.artistCredit,
    album: file.album.title,
    year: file.album.year ? String(file.album.year) : undefined,
    disc: shape.discs > 1 ? String(file.disc) : undefined,
    track: String(file.position).padStart(Math.max(2, String(shape.positions).length), '0'),
    title: file.trackTitle,
    ext: extension,
  }
}

/** Names from the file's own tags, for untrusted files when the admin asks for them. */
function tagValues(tags: FileTags, relPath: string, extension: string): TemplateValues {
  const multiDisc = (tags.discTotal ?? 0) > 1 || (tags.disc ?? 0) > 1
  return {
    albumartist: tags.compilation ? 'Various Artists' : tags.albumArtist ?? tags.artist,
    artist: tags.artist,
    album: tags.album,
    year: tags.year ? String(tags.year) : undefined,
    disc: multiDisc && tags.disc ? String(tags.disc) : undefined,
    track: tags.track ? String(tags.track).padStart(Math.max(2, String(tags.trackTotal ?? 0).length), '0') : undefined,
    title: tags.title ?? path.basename(relPath, extension),
    ext: extension,
  }
}

/** Cached directory listings under the root, by relative path. */
class DiskView {
  private readonly cache = new Map<string, Awaited<ReturnType<typeof readdirOrEmpty>>>()
  constructor(private readonly root: string) {}

  async list(relDir: string) {
    let entries = this.cache.get(relDir)
    if (!entries) {
      entries = await readdirOrEmpty(relDir ? resolveInRoot(this.root, relDir) : this.root)
      this.cache.set(relDir, entries)
    }
    return entries
  }

  /** Paths on disk that fold to the same key as `relPath`. */
  async matching(relPath: string): Promise<string[]> {
    const dir = path.posix.dirname(relPath)
    const parent = dir === '.' ? '' : dir
    const key = foldPath(path.posix.basename(relPath))
    return (await this.list(parent)).filter((entry) => foldPath(entry.name) === key).map((entry) => parent ? `${parent}/${entry.name}` : entry.name)
  }
}

type RootFile = { id: string; relPath: string; missing: boolean }

/**
 * Gives every audio move a unique target and decides which must be skipped, then
 * orders the rest so a file whose target is another moving file's current path runs
 * after that file has left.
 *
 * - Two files with the same target (ignoring case): a file already there (`unchanged`),
 *   or else the first by current path, keeps it; the others get " (2)", " (3)"…
 * - A target held by a file that is not moving (on disk or in the database): skipped.
 * - Files that would trade places with each other: skipped.
 */
async function resolveCollisions(moves: Plan[], unchanged: string[], inRoot: RootFile[], disk: DiskView): Promise<Plan[]> {
  const claims = new Set(unchanged.map(foldPath))
  const staying = moves.filter((move) => move.from === move.to)
  for (const move of staying) claims.add(foldPath(move.to))

  const movers = moves.filter((move) => move.from !== move.to)
    .sort((a, b) => compare(foldPath(a.to), foldPath(b.to)) || Number(foldPath(b.from) === foldPath(b.to)) - Number(foldPath(a.from) === foldPath(a.to)) || compare(a.from, b.from))
  const losers: Plan[] = []
  for (const move of movers) {
    const key = foldPath(move.to)
    if (claims.has(key)) losers.push(move)
    else claims.add(key)
  }

  const dbPaths = new Map<string, RootFile[]>()
  for (const file of inRoot) dbPaths.set(foldPath(file.relPath), [...dbPaths.get(foldPath(file.relPath)) ?? [], file])
  const fileIds = new Set(moves.map((move) => move.fileId))
  /** What holds `target` other than files leaving their current path in this batch. */
  const holder = async (target: string, move: Plan, leaving: Set<string>): Promise<string | null> => {
    for (const file of dbPaths.get(foldPath(target)) ?? []) {
      if (file.id === move.fileId || leaving.has(file.relPath)) continue
      return fileIds.has(file.id) ? 'a file in this batch that is not moving' : file.missing ? 'a missing library file' : 'another library file'
    }
    for (const found of await disk.matching(target)) {
      if (found !== move.from && !leaving.has(found)) return 'another file'
    }
    return null
  }

  const initiallyLeaving = new Set(movers.map((move) => move.from))
  for (const move of losers) {
    for (let n = 2; ; n += 1) {
      const candidate = joinRendered(move.rendered!, ` (${n})`)
      if (!claims.has(foldPath(candidate)) && !await holder(candidate, move, initiallyLeaving)) {
        claims.add(foldPath(candidate))
        move.to = candidate
        break
      }
    }
  }

  // Skipping one move can block another (its file now stays where the other wanted to
  // go), so repeat until nothing changes.
  for (;;) {
    const planned = movers.filter((move) => move.status === 'planned')
    const leaving = new Set(planned.map((move) => move.from))
    let changed = false
    for (const move of planned) {
      const taken = await holder(move.to, move, leaving)
      if (taken) {
        skip(move, `The destination is already taken by ${taken}`)
        changed = true
      }
    }
    if (changed) continue

    const order = orderMoves(planned)
    if (order.cycle) {
      skip(order.cycle, 'It would trade places with another file in this batch; move one of them by hand first')
      continue
    }
    return [...staying, ...order.moves, ...movers.filter((move) => move.status === 'skipped')]
  }
}

function skip(move: Plan, reason: string) {
  move.status = 'skipped'
  move.reason = reason
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Orders moves so each runs after the move vacating its target. Reports one move on a cycle, if any. */
function orderMoves(moves: Plan[]): { moves: Plan[]; cycle?: Plan } {
  const bySource = new Map<string, Plan[]>()
  for (const move of moves) bySource.set(foldPath(move.from), [...bySource.get(foldPath(move.from)) ?? [], move])
  const done = new Set<Plan>()
  const visiting = new Set<Plan>()
  const out: Plan[] = []
  const visit = (move: Plan): Plan | undefined => {
    if (done.has(move)) return undefined
    if (visiting.has(move)) return move
    visiting.add(move)
    for (const blocker of bySource.get(foldPath(move.to)) ?? []) {
      if (blocker === move) continue
      const cycle = visit(blocker)
      if (cycle) return cycle
    }
    visiting.delete(move)
    done.add(move)
    out.push(move)
    return undefined
  }
  for (const move of moves) {
    const cycle = visit(move)
    if (cycle) return { moves: out, cycle }
  }
  return { moves: out }
}

/**
 * Plans sidecars for every source folder whose audio files all move to one other
 * folder: covers, booklets, logs, cue sheets, playlists and `.lrc` files, the latter
 * renamed to follow their audio file. A folder with any audio file staying behind
 * keeps all its sidecars.
 */
async function planSidecars(planned: Plan[], inRoot: RootFile[], disk: DiskView, all: Plan[]): Promise<Plan[]> {
  const bySource = new Map<string, Plan[]>()
  for (const move of planned) {
    if (move.from === move.to) continue
    const dir = path.posix.dirname(move.from)
    bySource.set(dir, [...bySource.get(dir) ?? [], move])
  }
  const presentByDir = new Map<string, string[]>()
  for (const file of inRoot) {
    if (file.missing) continue
    const dir = path.posix.dirname(file.relPath)
    presentByDir.set(dir, [...presentByDir.get(dir) ?? [], file.relPath])
  }
  const claims = new Set(all.filter((move) => move.status === 'planned').map((move) => foldPath(move.to)))
  const out: Plan[] = []

  for (const [dir, moves] of [...bySource].sort(([a], [b]) => compare(a, b))) {
    const targetDirs = new Set(moves.map((move) => path.posix.dirname(move.to)))
    const targetDir = [...targetDirs][0]!
    if (targetDirs.size > 1 || targetDir === dir) continue
    const prefix = dir === '.' ? '' : `${dir}/`
    const entries = await disk.list(dir === '.' ? '' : dir)
    const moving = new Map(moves.map((move) => [move.from, move]))
    const audioHere = [
      ...entries.filter((entry) => entry.isFile() && audioExtensions.has(extensionOf(entry.name))).map((entry) => prefix + entry.name),
      ...presentByDir.get(dir) ?? [],
    ]
    if (!audioHere.every((file) => moving.has(file))) continue

    const stems = new Map(moves.map((move) => [path.posix.basename(move.from, path.posix.extname(move.from)), move]))
    for (const entry of entries) {
      const extension = extensionOf(entry.name)
      if (!entry.isFile() || entry.name.startsWith('.') || !sidecarExtensions.has(extension)) continue
      const stem = path.basename(entry.name, path.extname(entry.name))
      const audioMove = extension === 'lrc' ? stems.get(stem) : undefined
      const newStem = audioMove ? path.posix.basename(audioMove.to, path.posix.extname(audioMove.to)) : stem
      const to = `${targetDir}/${fileName(newStem, sanitizeExtension(extension))}`
      const plan: Plan = { fileId: null, kind: 'sidecar', from: prefix + entry.name, to, rendered: null, status: 'planned', reason: null }
      if (claims.has(foldPath(to))) skip(plan, 'Another file in this batch goes to the same place')
      else if ((await disk.matching(to)).length > 0) skip(plan, 'The destination is already taken by another file')
      else claims.add(foldPath(to))
      out.push(plan)
    }
  }
  return out
}
