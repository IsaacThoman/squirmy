import { rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { and, eq, inArray } from 'drizzle-orm'
import postgres from 'postgres'
import { getConfig } from '../../config.js'
import { db, getSql } from '../../database/client.js'
import { catalogIndexImports } from '../../database/schema.js'
import { AppError, conflict } from '../../lib/errors.js'
import { newId } from '../../lib/ids.js'
import { matchKey } from '../../lib/text.js'
import { parseCsv } from './csv.js'
import { decompressZstd, dumpDateFromName, findLatestDump, openSource, type OpenedSource } from './dump.js'
import { readTar } from './tar.js'

export type ImportOptions = {
  /** URL or local path of a `.tar.zst` canonical dump. Default: the newest published dump. */
  source?: string
  /** Size knob: keep at most this many recordings per artist credit, best first. Default: all. */
  recordingsPerArtist?: number | null
  /**
   * Shutting down: the import stops at once, keeps what it has committed and is left
   * `interrupted` for `resumeImport`. Cancelling is `cancelImport`.
   */
  signal?: AbortSignal
  /** Where to look for the newest dump when `source` is not given. */
  indexUrl?: string
  /** CSV records per committed chunk while loading: the most a restart can lose. Default 1,000,000. */
  chunkRecords?: number
  /** Called after each checkpoint commits. Tests use it to stop an import at a chosen point. */
  onCheckpoint?: (checkpoint: Checkpoint) => void
}

export type ResumeOptions = Pick<ImportOptions, 'signal' | 'chunkRecords' | 'onCheckpoint'> & {
  /** How long to wait for the import lock, which the stopping process may hold for a moment longer. */
  lockWaitMs?: number
}

export type ImportResult = { id: string; artists: number; albums: number; recordings: number; dumpDate: Date | null }

/** Thrown when an import stops because it was cancelled. */
export class ImportCancelledError extends Error {
  constructor() {
    super('The import was cancelled')
    this.name = 'ImportCancelledError'
  }
}

/** Thrown when an import stops because its process is shutting down; `resumeImport` carries on with it. */
export class ImportInterruptedError extends Error {
  constructor(readonly id: string) {
    super('The import was interrupted by a shutdown')
    this.name = 'ImportInterruptedError'
  }
}

/**
 * What an import has committed. Each piece of work commits in one transaction with the
 * checkpoint that records it, so the two can never disagree, whenever the process stops.
 */
export type Checkpoint = {
  /** Per dump file: CSV records (after the header) already in its staging table, and whether that was all of them. */
  files: Partial<Record<DumpFile, { records: number; done: boolean }>>
  /** Recording rows in the raw staging table. */
  rows: number
  dumpDate: string | null
  /** Build statements completed. */
  built: number
  /**
   * `pg_postmaster_start_time()` when the import began. The staging tables are unlogged,
   * and Postgres empties those when it recovers from a crash; a different start time
   * means they cannot be trusted, and the import starts again from the beginning.
   */
  database: string
  /** Resumes in a row that found the checkpoint where the previous one left it. */
  stalls: number
  /** The progress the last resume started from, to count stalls. */
  resumedFrom: string | null
}

// Session advisory lock: one import at a time, released if the process dies.
const lockKey = 'squirmy:catalog-index-import'
const lockBusy = 'catalog_index_import_running'
const progressMs = 2_000
// An import that keeps dying at the same point (a statement that runs the server out of
// memory, say) would otherwise be resumed for ever.
const maxStalls = 5
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The variant MusicBrainz uses for compilations. Like the bracketed special-purpose
// artists ([unknown], [traditional]), it is not an artist anyone searches for.
const variousArtists = '89ad4ac3-39f7-470e-963a-56509c546377'

const staging = {
  raw: 'catalog_index_raw',
  releases: 'catalog_index_raw_releases',
  redirects: 'catalog_index_raw_redirects',
  versions: 'catalog_index_tmp_versions',
  editions: 'catalog_index_tmp_editions',
  artists: 'catalog_index_tmp_artists',
  credits: 'catalog_index_tmp_credits',
  next: 'catalog_index_next',
}
const indexedKinds = ['artist', 'album', 'recording'] as const

/** Escapes a value for Postgres COPY text format. */
function copyValue(value: string): string {
  return /[\\\t\n\r]/.test(value) ? value.replace(/[\\\t\n\r]/g, (char) => ({ '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[char]!) : value
}

/** `matchKey` with a one-entry cache: the dump lists each artist's rows together. */
function memoKey() {
  let lastValue = ''
  let lastKey = ''
  return (value: string) => {
    if (value !== lastValue) {
      lastValue = value
      lastKey = matchKey(value)
    }
    return lastKey
  }
}

function columnsOf(header: string[], required: string[], file: string): number[] {
  return required.map((name) => {
    const index = header.indexOf(name)
    if (index === -1) throw new Error(`${file} has no ${name} column; is this a canonical MusicBrainz dump?`)
    return index
  })
}

/** Turns rows of one dump file into COPY text lines for its staging table. */
type LineMaker = { header: (row: string[]) => void; line: (row: string[]) => string | null }

/** The main data file, into `catalog_index_raw`. */
function recordingLines(): LineMaker {
  const artistKey = memoKey()
  const releaseKey = memoKey()
  let columns: number[] = []
  let width = 0
  return {
    header(row) {
      columns = columnsOf(row, ['recording_mbid', 'recording_name', 'artist_mbids', 'artist_credit_name', 'release_mbid', 'release_name', 'score'], 'canonical_musicbrainz_data.csv')
      width = row.length
    },
    line(row) {
      if (row.length !== width) return null
      const [recordingMbid, recordingName, artistMbids, artistName, releaseMbid, releaseName, score] = columns.map((index) => row[index]!) as [string, string, string, string, string, string, string]
      if (!uuidPattern.test(recordingMbid) || !uuidPattern.test(releaseMbid) || !/^\d+$/.test(score) || !artistMbids) return null
      return `${recordingMbid}\t${copyValue(recordingName)}\t${copyValue(matchKey(recordingName))}\t${artistMbids}\t${copyValue(artistName)}\t${copyValue(artistKey(artistName))}\t${releaseMbid}\t${copyValue(releaseName)}\t${copyValue(releaseKey(releaseName))}\t${score}\n`
    },
  }
}

/** A redirect file: the named MBID columns. */
function mbidLines(file: string, names: string[]): LineMaker {
  let columns: number[] = []
  return {
    header(row) {
      columns = columnsOf(row, names, file)
    },
    line(row) {
      const values = columns.map((index) => row[index] ?? '')
      return values.every((value) => uuidPattern.test(value)) ? `${values.join('\t')}\n` : null
    },
  }
}

const dumpFiles = {
  'canonical_musicbrainz_data.csv': { table: staging.raw, lines: recordingLines, recordings: true },
  'canonical_recording_redirect.csv': { table: staging.redirects, lines: () => mbidLines('canonical_recording_redirect.csv', ['canonical_recording_mbid']), recordings: false },
  'canonical_release_redirect.csv': { table: staging.releases, lines: () => mbidLines('canonical_release_redirect.csv', ['release_mbid', 'release_group_mbid']), recordings: false },
}
type DumpFile = keyof typeof dumpFiles
const isDumpFile = (file: string): file is DumpFile => Object.hasOwn(dumpFiles, file)

/**
 * How many of the most popular rows of each kind go into the small `head` trigram
 * index that answers fuzzy queries. Its size, not the dump's, sets search latency.
 */
const headSize = { artist: 250_000, album: 250_000, recording: 1_000_000 }

/**
 * The SQL that derives the searchable rows from the raw dump rows.
 *
 * Popularity comes from how much MusicBrainz holds about something, which tracks
 * fame well. The dump's own `score` is not popularity: it orders releases by how
 * canonical they are (albums before singles, originals before reissues).
 * - A recording's versions: other recordings with the same artist and title, which
 *   redirect to it (live takes, remasters, re-recordings). Hits have many.
 * - An album's editions: releases in its release group. Famous albums have hundreds.
 * - An artist's size: recordings credited to them plus all their versions.
 * Each count is taken as ln(1 + n) and scaled to 0..1 against the 99.9th percentile
 * of its kind, so one freak outlier does not flatten everything else. Albums and
 * recordings blend their own count with their artist credit's weight (that of its
 * best-known artist) and a little of the dump's canonical order.
 */
function buildStatements(recordingsPerArtist: number | null): string[] {
  const { raw, releases, versions, editions, artists, credits, next } = staging
  const scaled = (value: string, table: string, column: string) =>
    `least(1, ln(1 + ${value}) / greatest((select ln(1 + percentile_cont(0.999) within group (order by ${column})) from ${table}), 1e-9))`
  const canonical = (alias: string) => `(1 - ${alias}.rank::real / greatest((select max(rank) from ${raw}), 1))`
  const recordings = recordingsPerArtist
    ? `(select *, row_number() over (partition by artist_mbids order by rank, recording_mbid) as position from ${raw}) r`
    : `${raw} r`
  const keep = recordingsPerArtist ? ` and r.position <= ${recordingsPerArtist}` : ''
  const head = (kind: keyof typeof headSize) => `row_number() over (order by score desc) <= ${headSize[kind]}`
  return [
    `create unlogged table ${versions} as
      select canonical_recording_mbid as mbid, count(*)::int as versions from ${staging.redirects} group by 1`,
    `alter table ${versions} add primary key (mbid)`,
    `create unlogged table ${editions} as
      select release_group_mbid, count(*)::int as editions from ${releases} group by 1`,
    `create unlogged table ${artists} as
      select a.mbid, a.size, n.name, n.name_key,
             a.mbid = '${variousArtists}' or coalesce(n.name like '[%]', false) as special
      from (select m.mbid::uuid as mbid, count(*)::int + coalesce(sum(v.versions), 0)::int as size
            from ${raw} r cross join unnest(string_to_array(r.artist_mbids, ',')) as m(mbid)
            left join ${versions} v on v.mbid = r.recording_mbid
            group by 1) a
      left join (
        select distinct on (artist_mbids) artist_mbids::uuid as mbid, artist_name as name, artist_key as name_key
        from (select artist_mbids, artist_name, artist_key, count(*) as uses from ${raw}
              where artist_mbids not like '%,%' group by 1, 2, 3) named
        order by artist_mbids, uses desc, artist_name
      ) n on n.mbid = a.mbid`,
    `delete from ${artists} where special`,
    `create unlogged table ${credits} as
      select c.artist_mbids, max(${scaled('a.size', artists, 'size')}) as weight
      from (select distinct artist_mbids from ${raw}) c
      cross join unnest(string_to_array(c.artist_mbids, ',')) as m(mbid)
      join ${artists} a on a.mbid = m.mbid::uuid
      group by c.artist_mbids`,
    `alter table ${credits} add primary key (artist_mbids)`,
    `create table ${next} (
      kind text not null, mbid uuid not null, name text not null, artist_name text, album_name text,
      name_key text not null, score real not null, head boolean not null)`,
    `insert into ${next} (kind, mbid, name, name_key, score, head)
      select 'artist', mbid, name, name_key, score, ${head('artist')}
      from (select a.*, ${scaled('a.size', artists, 'size')} as score from ${artists} a) a
      where name is not null and name_key <> ''
      order by score desc`,
    // An album is a release group, named after its most canonical release in the dump.
    // Its artist is the credit on most of its tracks, or Various Artists when no
    // credit covers half of them.
    `insert into ${next} (kind, mbid, name, artist_name, name_key, score, head)
      select 'album', release_group_mbid, release_name, artist_name, release_key, score, ${head('album')}
      from (
        select g.*, 0.5 * ${scaled('e.editions', editions, 'editions')}
                    + 0.4 * g.weight + 0.1 * ${canonical('g')} as score
        from (
          select distinct on (rg.release_group_mbid) rg.release_group_mbid, d.*
          from (
            select p.release_mbid, p.release_name, p.release_key, p.rank,
                   case when p.tracks * 2 > p.total then p.artist_name else 'Various Artists' end as artist_name,
                   case when p.tracks * 2 > p.total then coalesce(c.weight, 0) else 0 end as weight
            from (
              select *, sum(tracks) over w as total, row_number() over (w order by tracks desc, artist_name) as position
              from (select release_mbid, artist_mbids, artist_name, count(*) as tracks, min(rank) as rank,
                           min(release_name) as release_name, min(release_key) as release_key
                    from ${raw} group by 1, 2, 3) per_credit
              window w as (partition by release_mbid)
            ) p
            left join ${credits} c on c.artist_mbids = p.artist_mbids
            where p.position = 1
          ) d
          join ${releases} rg on rg.release_mbid = d.release_mbid
          order by rg.release_group_mbid, d.rank
        ) g
        join ${editions} e using (release_group_mbid)
        where g.release_key <> ''
      ) albums
      order by score desc`,
    `insert into ${next} (kind, mbid, name, artist_name, album_name, name_key, score, head)
      select 'recording', recording_mbid, recording_name, artist_name, release_name, recording_key, score, ${head('recording')}
      from (
        select r.*, 0.5 * ${scaled('coalesce(v.versions, 0)', versions, 'versions')}
                    + 0.4 * coalesce(c.weight, 0) + 0.1 * ${canonical('r')} as score
        from ${recordings}
        left join ${credits} c on c.artist_mbids = r.artist_mbids
        left join ${versions} v on v.mbid = r.recording_mbid
        where r.recording_key <> ''${keep}
      ) recordings
      order by score desc`,
    `drop table ${raw}, ${releases}, ${staging.redirects}, ${versions}, ${editions}, ${artists}, ${credits}`,
    ...indexedKinds.map((kind) => `create index ${next}_${kind}_head on ${next} using gin (name_key gin_trgm_ops) where kind = '${kind}' and head`),
    `create index ${next}_prefix on ${next} (kind, (name_key collate "C"))`,
    `analyze ${next}`,
  ]
}

/** Drops every staging table an import creates. Safe to call when none exist. */
async function dropStaging(sql: postgres.Sql) {
  await sql.unsafe(`drop table if exists ${Object.values(staging).join(', ')}`)
}

/** Where downloads are kept while their import runs, so a resumed one does not fetch the dump again. */
const downloadDir = () => path.join(getConfig().SQUIRMY_DATA_DIR, 'catalog-index')
const downloadFile = (id: string) => path.join(downloadDir(), `${id}.tar.zst`)

/** Drops what an import that will not be resumed left behind: staging tables and its download. */
async function discardWork(sql: postgres.Sql, ids: string[] | 'all') {
  await dropStaging(sql)
  if (ids === 'all') await rm(downloadDir(), { recursive: true, force: true })
  else for (const id of ids) await rm(downloadFile(id), { force: true })
}

async function databaseStartedAt(sql: postgres.Sql) {
  const [row] = await sql<{ started: string }[]>`select pg_postmaster_start_time()::text as started`
  return row!.started
}

const isLockBusy = (error: unknown) => error instanceof AppError && error.code === lockBusy

/**
 * Runs `work` holding the import lock, on a connection of its own: the import keeps it
 * for hours, streaming the download into COPY, and the query pool is sized for short
 * statements. Waits up to `waitMs` for the lock, then answers 409.
 */
async function withImportLock<T>(waitMs: number, signal: AbortSignal | undefined, onAbort: () => Error, work: (sql: postgres.ReservedSql) => Promise<T>): Promise<T> {
  const own = postgres(getConfig().DATABASE_URL, {
    max: 1, max_lifetime: null, prepare: false, onnotice: () => {}, connection: { application_name: 'squirmy-catalog-index' },
  })
  try {
    const sql = await own.reserve()
    try {
      const deadline = Date.now() + waitMs
      for (;;) {
        const [lock] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${lockKey})) as locked`
        if (lock?.locked) break
        if (signal?.aborted) throw onAbort()
        if (Date.now() >= deadline) throw conflict('A search index import is already running', lockBusy)
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      try {
        return await work(sql)
      } finally {
        await sql`select pg_advisory_unlock(hashtext(${lockKey}))`
      }
    } finally {
      sql.release()
    }
  } finally {
    await own.end({ timeout: 5 })
  }
}

/**
 * Downloads (or reads) a MusicBrainz canonical data dump and rebuilds the local
 * search index from it.
 *
 * The archive is streamed end to end with bounded memory: HTTP body or file, zstd,
 * tar, CSV, then Postgres COPY into unlogged staging tables. The searchable rows are
 * derived into a fresh table, indexed, and swapped in with a rename in one short
 * transaction, so search keeps answering from the old index throughout and a failed
 * or cancelled import leaves it untouched. Only one import runs at a time; another
 * caller gets a 409. Progress is written to `catalog_index_imports` every couple of
 * seconds, and setting `cancel_requested` on the running row (see `cancelImport`)
 * stops it from any process.
 *
 * Loading commits every `chunkRecords` rows and each build statement commits on its
 * own, each with a checkpoint. When `signal` aborts (the server is shutting down), the
 * import stops, keeps all of that, and `resumeImport` later carries on from there.
 */
export async function importCanonicalDump(options: ImportOptions = {}): Promise<ImportResult> {
  return withImportLock(0, undefined, () => new ImportCancelledError(), async (sql) => {
    const recordingsPerArtist = options.recordingsPerArtist ?? null
    // Holding the lock means any row still marked running or interrupted belongs to a process
    // that died or stopped. This import drops their staging tables, so they can no longer resume.
    const replaced = await db.update(catalogIndexImports)
      .set({ state: 'failed', error: 'The import was interrupted', finishedAt: new Date() })
      .where(inArray(catalogIndexImports.state, ['running', 'interrupted']))
      .returning({ id: catalogIndexImports.id })
    if (replaced.length > 0) await discardWork(sql, 'all')
    const id = newId()
    await db.insert(catalogIndexImports).values({ id, state: 'running', phase: 'download', source: options.source ?? null, recordingsPerArtist })
    return execute(sql, { id, source: options.source ?? null, recordingsPerArtist, totalBytes: null, checkpoint: null, indexUrl: options.indexUrl }, options)
  })
}

/**
 * Carries on with an import a shutdown or a crash stopped, from its last checkpoint.
 * Returns null when there is nothing to resume: it was cancelled, finished, failed, or
 * another process is already running an import.
 */
export async function resumeImport(id: string, options: ResumeOptions = {}): Promise<ImportResult | null> {
  try {
    return await withImportLock(options.lockWaitMs ?? 30_000, options.signal, () => new ImportInterruptedError(id), async (sql) => {
      const [row] = await db.select().from(catalogIndexImports).where(eq(catalogIndexImports.id, id))
      // Holding the lock, a row still marked running is one whose process died.
      if (!row || (row.state !== 'interrupted' && row.state !== 'running')) return null
      if (row.cancelRequested) {
        await discardWork(sql, [id])
        await db.update(catalogIndexImports).set({ state: 'cancelled', finishedAt: new Date() }).where(eq(catalogIndexImports.id, id))
        return null
      }
      let checkpoint = row.checkpoint as Checkpoint | null
      if (checkpoint && checkpoint.database !== await databaseStartedAt(sql)) checkpoint = null
      if (checkpoint) {
        const from = JSON.stringify({ files: checkpoint.files, built: checkpoint.built })
        checkpoint = { ...checkpoint, stalls: from === checkpoint.resumedFrom ? checkpoint.stalls + 1 : 0, resumedFrom: from }
        if (checkpoint.stalls >= maxStalls) {
          await discardWork(sql, [id])
          await db.update(catalogIndexImports)
            .set({ state: 'failed', error: `The import stopped ${maxStalls + 1} times in a row at the same point`, finishedAt: new Date() })
            .where(eq(catalogIndexImports.id, id))
          return null
        }
      }
      await db.update(catalogIndexImports)
        .set({ state: 'running', phase: checkpoint?.built ? 'build' : 'download', resumes: row.resumes + 1, resumedAt: new Date(), checkpoint })
        .where(eq(catalogIndexImports.id, id))
      return execute(sql, { id, source: row.source, recordingsPerArtist: row.recordingsPerArtist, totalBytes: row.totalBytes, checkpoint }, options)
    })
  } catch (error) {
    if (isLockBusy(error)) return null
    throw error
  }
}

type Job = {
  id: string
  source: string | null
  recordingsPerArtist: number | null
  totalBytes: number | null
  /** Null starts from the beginning. */
  checkpoint: Checkpoint | null
  indexUrl?: string
}

async function execute(sql: postgres.ReservedSql, job: Job, options: Pick<ImportOptions, 'signal' | 'chunkRecords' | 'onCheckpoint'>): Promise<ImportResult> {
  const { id } = job
  const chunkRecords = options.chunkRecords ?? 1_000_000
  const controller = new AbortController()
  const cancel = () => controller.abort(new ImportCancelledError())
  const interrupt = () => controller.abort(new ImportInterruptedError(id))
  if (options.signal?.aborted) interrupt()
  options.signal?.addEventListener('abort', interrupt)
  let running: postgres.PendingQuery<postgres.Row[]> | undefined
  controller.signal.addEventListener('abort', () => void running?.cancel())
  const run = async (statement: string) => {
    if (controller.signal.aborted) throw controller.signal.reason
    running = sql.unsafe(statement)
    try {
      await running
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error
    } finally {
      running = undefined
    }
  }

  const copyInto = async (table: string, text: AsyncIterable<string>) => {
    const copy = await sql.unsafe(`copy ${table} from stdin`).writable()
    try {
      await pipeline(Readable.from(text), copy, { signal: controller.signal })
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error
    }
  }

  let checkpoint = job.checkpoint ?? undefined
  // Runs `work` and records `next()` in one transaction, so a stop at any moment leaves
  // either both or neither. The checkpoint row is updated last, so its lock is held only
  // for the commit and never blocks progress reports or a cancel. Work that finished as a
  // stop came in is still committed: the next `run` stops the import.
  const commit = async (work: () => Promise<void>, next: () => Checkpoint) => {
    await run('begin')
    try {
      await work()
      const value = next()
      await sql`update catalog_index_imports set checkpoint = ${sql.json(value)} where id = ${id}`
      await sql.unsafe('commit')
      checkpoint = value
    } catch (error) {
      await sql.unsafe('rollback').catch(() => {})
      throw error
    }
    options.onCheckpoint?.(checkpoint)
  }

  let opened: OpenedSource | undefined
  const progress = { phase: 'download' as 'download' | 'build' | 'swap', bytesRead: 0, totalBytes: job.totalBytes, rows: checkpoint?.rows ?? 0 }
  const report = async () => {
    progress.totalBytes = opened?.totalBytes ?? progress.totalBytes
    const [row] = await db.update(catalogIndexImports)
      .set({ phase: progress.phase, bytesRead: progress.bytesRead, totalBytes: progress.totalBytes, rowsRead: progress.rows })
      .where(and(eq(catalogIndexImports.id, id), eq(catalogIndexImports.state, 'running')))
      .returning({ cancelRequested: catalogIndexImports.cancelRequested })
    if (row?.cancelRequested) cancel()
  }
  const timer = setInterval(() => void report().catch(() => {}), progressMs)

  /** Drops whatever a previous run left and creates empty staging tables: an import from the beginning. */
  const startOver = async () => {
    await dropStaging(sql)
    progress.rows = 0
    const database = await databaseStartedAt(sql)
    await commit(async () => {
      await run(`create unlogged table ${staging.raw} (
        recording_mbid uuid not null, recording_name text not null, recording_key text not null,
        artist_mbids text not null, artist_name text not null, artist_key text not null,
        release_mbid uuid not null, release_name text not null, release_key text not null, rank integer not null)`)
      await run(`create unlogged table ${staging.releases} (release_mbid uuid not null, release_group_mbid uuid not null)`)
      await run(`create unlogged table ${staging.redirects} (canonical_recording_mbid uuid not null)`)
    }, () => ({ files: {}, rows: 0, dumpDate: null, built: 0, database, stalls: checkpoint?.stalls ?? 0, resumedFrom: checkpoint?.resumedFrom ?? null }))
  }

  const load = async (source: string, at: Checkpoint) => {
    let dumpDate = at.dumpDate ? new Date(at.dumpDate) : dumpDateFromName(source)
    if (at.built > 0 || Object.keys(dumpFiles).every((file) => at.files[file as DumpFile]?.done)) return dumpDate

    // One chunk of a dump file per transaction. Rows an earlier run committed are parsed and skipped.
    const copyFile = async (file: DumpFile, body: AsyncIterable<Buffer>) => {
      const spec = dumpFiles[file]
      const lines = spec.lines()
      const skip = checkpoint!.files[file]?.records ?? 0
      const batches = parseCsv(body)[Symbol.asyncIterator]()
      let header = true
      let records = 0
      let ended = false
      // A chunk ends inside a CSV batch; the rest of the batch starts the next one.
      let batch: string[][] = []
      let position = 0
      async function* chunk(): AsyncGenerator<string> {
        let taken = 0
        while (taken < chunkRecords) {
          if (position === batch.length) {
            const next = await batches.next()
            if (next.done) {
              ended = true
              return
            }
            batch = next.value
            position = 0
          }
          let out = ''
          for (; position < batch.length && taken < chunkRecords; position++) {
            const row = batch[position]!
            if (header) {
              lines.header(row)
              header = false
              continue
            }
            records++
            if (records <= skip) continue
            taken++
            const line = lines.line(row)
            if (!line) continue
            out += line
            if (spec.recordings) progress.rows++
          }
          if (out) yield out
        }
      }
      while (!ended) {
        const rowsBefore = progress.rows
        try {
          await commit(() => copyInto(spec.table, chunk()), () => ({
            ...checkpoint!, dumpDate: dumpDate?.toISOString() ?? null, rows: progress.rows,
            files: { ...checkpoint!.files, [file]: { records, done: ended } },
          }))
        } catch (error) {
          progress.rows = rowsBefore
          throw error
        }
      }
    }

    opened = await openSource(source, controller.signal, { cacheFile: downloadFile(id), totalBytes: job.totalBytes })
    progress.totalBytes = opened.totalBytes
    progress.bytesRead = 0
    const archive = decompressZstd(opened.stream)
    opened.stream.on('data', (chunk: Buffer) => { progress.bytesRead += chunk.length })
    for await (const entry of readTar(archive)) {
      const file = entry.path.split('/').at(-1)!
      if (file === 'TIMESTAMP') {
        const chunks: Buffer[] = []
        for await (const chunk of entry.body) chunks.push(chunk)
        const stamp = new Date(`${Buffer.concat(chunks).toString('utf8').trim().replace(' ', 'T')}Z`)
        if (!Number.isNaN(stamp.getTime())) dumpDate = stamp
      } else if (isDumpFile(file) && !checkpoint!.files[file]?.done) {
        await copyFile(file, entry.body)
      }
    }
    for (const file of Object.keys(dumpFiles) as DumpFile[]) {
      if (!checkpoint!.files[file]?.done) throw new Error(`The archive has no ${file}; is it a canonical MusicBrainz dump?`)
    }
    return dumpDate
  }

  const build = async () => {
    progress.phase = 'build'
    await report()
    // Index builds and sorts go much faster with more than Postgres's 64 MB default.
    await run(`set maintenance_work_mem = '256MB'`)
    const statements = buildStatements(job.recordingsPerArtist)
    for (let step = checkpoint!.built; step < statements.length; step++) {
      await commit(() => run(statements[step]!), () => ({ ...checkpoint!, built: step + 1 }))
    }
  }

  try {
    const source = job.source ?? await findLatestDump(job.indexUrl, controller.signal)
    if (!job.source) await db.update(catalogIndexImports).set({ source }).where(eq(catalogIndexImports.id, id))

    let dumpDate: Date | null
    let resumed = Boolean(checkpoint)
    for (;;) {
      try {
        if (!resumed) await startOver()
        dumpDate = await load(source, checkpoint!)
        await build()
        break
      } catch (error) {
        // A table the checkpoint counts on is gone (dropped by hand, or a database restored
        // from a backup taken mid-import): start again from the beginning, once.
        if (!resumed || controller.signal.aborted || (error as { code?: string }).code !== '42P01') throw error
        resumed = false
        opened?.stream.destroy()
      }
    }
    const counts = Object.fromEntries((await sql.unsafe<{ kind: string; count: number }[]>(
      `select kind, count(*)::int as count from ${staging.next} group by kind`)).map((row) => [row.kind, row.count]))

    progress.phase = 'swap'
    await report()
    if (controller.signal.aborted) throw controller.signal.reason
    const result = { id, artists: counts.artist ?? 0, albums: counts.album ?? 0, recordings: counts.recording ?? 0, dumpDate }
    await getSql().begin(async (tx) => {
      // Readers hold the old table briefly; waiting forever would also block every new search.
      await tx`set local lock_timeout = '30s'`
      await tx.unsafe(`drop table catalog_index`)
      await tx.unsafe(`alter table ${staging.next} rename to catalog_index`)
      for (const suffix of [...indexedKinds.map((kind) => `${kind}_head`), 'prefix']) {
        await tx.unsafe(`alter index ${staging.next}_${suffix} rename to catalog_index_${suffix}`)
      }
      await tx`update catalog_index_imports set state = 'replaced' where state = 'active'`
      await tx`
        update catalog_index_imports
        set state = 'active', phase = null, finished_at = now(), dump_date = ${dumpDate?.toISOString() ?? null},
            artists = ${result.artists}, albums = ${result.albums}, recordings = ${result.recordings},
            bytes_read = ${progress.bytesRead}, total_bytes = ${opened?.totalBytes ?? progress.totalBytes}, rows_read = ${progress.rows}, checkpoint = null
        where id = ${id}`
    })
    await rm(downloadFile(id), { force: true }).catch(() => {})
    return result
  } catch (error) {
    const reason: unknown = controller.signal.aborted ? controller.signal.reason : undefined
    if (reason instanceof ImportInterruptedError) {
      // Staging tables, checkpoint and the downloaded part stay for the next worker.
      await db.update(catalogIndexImports)
        .set({ state: 'interrupted', bytesRead: progress.bytesRead, totalBytes: opened?.totalBytes ?? progress.totalBytes, rowsRead: checkpoint?.rows ?? 0 })
        .where(and(eq(catalogIndexImports.id, id), eq(catalogIndexImports.state, 'running')))
      throw reason
    }
    const cancelled = reason instanceof ImportCancelledError
    await discardWork(sql, [id]).catch(() => {})
    await db.update(catalogIndexImports)
      .set({
        state: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : (error as Error).message,
        finishedAt: new Date(),
        bytesRead: progress.bytesRead,
        rowsRead: progress.rows,
        checkpoint: null,
      })
      .where(eq(catalogIndexImports.id, id))
    throw cancelled ? reason : error
  } finally {
    clearInterval(timer)
    opened?.stream.destroy()
    options.signal?.removeEventListener('abort', interrupt)
    await sql`reset maintenance_work_mem`.catch(() => {})
  }
}

/** The advisory import lock is free: no process is running an import. */
const lockIsFree = (sql: postgres.Sql) => sql`
  not exists (
    select 1 from pg_locks
    where locktype = 'advisory' and objsubid = 1
      and database = (select oid from pg_database where datname = current_database())
      and ((classid::bigint << 32) | objid::bigint) = hashtext(${lockKey})::bigint
  )`

/**
 * Marks imports still `running` as interrupted when no process holds the import lock:
 * the worker that ran them was killed (OOM, SIGKILL, power loss) before it could record
 * it. They resume from their last checkpoint like those a shutdown stopped. Returns
 * whether any row was marked. One statement, so it cannot race an import that is
 * starting: that one takes the lock before it inserts or claims its row.
 */
export async function markInterruptedImports(): Promise<boolean> {
  const sql = getSql()
  const rows = await sql<{ id: string }[]>`
    update catalog_index_imports set state = 'interrupted'
    where state = 'running' and ${lockIsFree(sql)}
    returning id`
  return rows.length > 0
}

/** Imports waiting to be resumed, with the resume count that tells one attempt from the next. */
export async function interruptedImports(): Promise<{ id: string; resumes: number }[]> {
  return db.select({ id: catalogIndexImports.id, resumes: catalogIndexImports.resumes })
    .from(catalogIndexImports).where(eq(catalogIndexImports.state, 'interrupted'))
}

/** Asks the running import, in whichever process it runs, to stop. Returns false if none is running. */
export async function cancelImport(): Promise<boolean> {
  await markInterruptedImports()
  const rows = await db.update(catalogIndexImports)
    .set({ cancelRequested: true })
    .where(inArray(catalogIndexImports.state, ['running', 'interrupted']))
    .returning({ id: catalogIndexImports.id, state: catalogIndexImports.state })
  if (rows.length === 0) return false
  // No process reads the request of an interrupted import, so it ends here, with what it
  // left behind. A worker that holds the lock is just taking it up and sees the request itself.
  if (rows.some((row) => row.state === 'interrupted')) {
    await withImportLock(0, undefined, () => new ImportCancelledError(), async (sql) => {
      const ended = await db.update(catalogIndexImports)
        .set({ state: 'cancelled', finishedAt: new Date(), checkpoint: null })
        .where(and(eq(catalogIndexImports.state, 'interrupted'), eq(catalogIndexImports.cancelRequested, true)))
        .returning({ id: catalogIndexImports.id })
      if (ended.length > 0) await discardWork(sql, ended.map((row) => row.id))
    }).catch((error: unknown) => {
      if (!isLockBusy(error)) throw error
    })
  }
  return true
}
