import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { and, eq } from 'drizzle-orm'
import postgres from 'postgres'
import { getConfig } from '../../config.js'
import { db, getSql } from '../../database/client.js'
import { catalogIndexImports } from '../../database/schema.js'
import { conflict } from '../../lib/errors.js'
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
  /** Aborts the import; the staging tables are dropped and the current index is kept. */
  signal?: AbortSignal
  /** Where to look for the newest dump when `source` is not given. */
  indexUrl?: string
}

export type ImportResult = { id: string; artists: number; albums: number; recordings: number; dumpDate: Date | null }

/** Thrown when an import stops because it was cancelled. */
export class ImportCancelledError extends Error {
  constructor() {
    super('The import was cancelled')
    this.name = 'ImportCancelledError'
  }
}

// Session advisory lock: one import at a time, released if the process dies.
const lockKey = 'squirmy:catalog-index-import'
const progressMs = 2_000
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

/** Turns CSV batches of the main data file into COPY text for `catalog_index_raw`. */
async function* recordingCopyText(batches: AsyncIterable<string[][]>, counter: { rows: number }): AsyncGenerator<string> {
  const artistKey = memoKey()
  const releaseKey = memoKey()
  let columns: number[] | undefined
  let width = 0
  for await (const batch of batches) {
    let out = ''
    for (const row of batch) {
      if (!columns) {
        columns = columnsOf(row, ['recording_mbid', 'recording_name', 'artist_mbids', 'artist_credit_name', 'release_mbid', 'release_name', 'score'], 'canonical_musicbrainz_data.csv')
        width = row.length
        continue
      }
      if (row.length !== width) continue
      const [recordingMbid, recordingName, artistMbids, artistName, releaseMbid, releaseName, score] = columns.map((index) => row[index]!) as [string, string, string, string, string, string, string]
      if (!uuidPattern.test(recordingMbid) || !uuidPattern.test(releaseMbid) || !/^\d+$/.test(score) || !artistMbids) continue
      out += `${recordingMbid}\t${copyValue(recordingName)}\t${copyValue(matchKey(recordingName))}\t${artistMbids}\t${copyValue(artistName)}\t${copyValue(artistKey(artistName))}\t${releaseMbid}\t${copyValue(releaseName)}\t${copyValue(releaseKey(releaseName))}\t${score}\n`
      counter.rows++
    }
    if (out) yield out
  }
}

/** Turns CSV batches of a redirect file into COPY text holding the named MBID columns. */
async function* mbidCopyText(batches: AsyncIterable<string[][]>, file: string, names: string[]): AsyncGenerator<string> {
  let columns: number[] | undefined
  for await (const batch of batches) {
    let out = ''
    for (const row of batch) {
      if (!columns) {
        columns = columnsOf(row, names, file)
        continue
      }
      const values = columns.map((index) => row[index] ?? '')
      if (values.every((value) => uuidPattern.test(value))) out += `${values.join('\t')}\n`
    }
    if (out) yield out
  }
}

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
 */
export async function importCanonicalDump(options: ImportOptions = {}): Promise<ImportResult> {
  // A connection of its own: the import keeps it for hours, streaming the download into
  // COPY, and the query pool is sized for short statements.
  const own = postgres(getConfig().DATABASE_URL, {
    max: 1, max_lifetime: null, prepare: false, onnotice: () => {}, connection: { application_name: 'squirmy-catalog-index' },
  })
  try {
    const sql = await own.reserve()
    try {
      const [lock] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${lockKey})) as locked`
      if (!lock?.locked) throw conflict('A search index import is already running', 'catalog_index_import_running')
      try {
        return await runImport(sql, options)
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

async function runImport(sql: postgres.ReservedSql, options: ImportOptions): Promise<ImportResult> {
  const recordingsPerArtist = options.recordingsPerArtist ?? null
  // Holding the lock means any row still marked running belongs to a process that died.
  await db.update(catalogIndexImports)
    .set({ state: 'failed', error: 'The import was interrupted', finishedAt: new Date() })
    .where(eq(catalogIndexImports.state, 'running'))
  const id = newId()
  await db.insert(catalogIndexImports).values({ id, state: 'running', phase: 'download', source: options.source ?? null, recordingsPerArtist })

  const controller = new AbortController()
  const abort = () => controller.abort(new ImportCancelledError())
  if (options.signal?.aborted) abort()
  options.signal?.addEventListener('abort', abort)
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
    await pipeline(Readable.from(text), copy, { signal: controller.signal })
  }

  const progress = { phase: 'download' as 'download' | 'build' | 'swap', bytesRead: 0, totalBytes: null as number | null, rows: 0 }
  const report = async () => {
    const [row] = await db.update(catalogIndexImports)
      .set({ phase: progress.phase, bytesRead: progress.bytesRead, totalBytes: progress.totalBytes, rowsRead: progress.rows })
      .where(and(eq(catalogIndexImports.id, id), eq(catalogIndexImports.state, 'running')))
      .returning({ cancelRequested: catalogIndexImports.cancelRequested })
    if (row?.cancelRequested) abort()
  }
  const timer = setInterval(() => void report().catch(() => {}), progressMs)
  let opened: OpenedSource | undefined

  try {
    await dropStaging(sql)
    const source = options.source ?? await findLatestDump(options.indexUrl, controller.signal)
    if (!options.source) await db.update(catalogIndexImports).set({ source }).where(eq(catalogIndexImports.id, id))

    await run(`create unlogged table ${staging.raw} (
      recording_mbid uuid not null, recording_name text not null, recording_key text not null,
      artist_mbids text not null, artist_name text not null, artist_key text not null,
      release_mbid uuid not null, release_name text not null, release_key text not null, rank integer not null)`)
    await run(`create unlogged table ${staging.releases} (release_mbid uuid not null, release_group_mbid uuid not null)`)
    await run(`create unlogged table ${staging.redirects} (canonical_recording_mbid uuid not null)`)

    opened = await openSource(source, controller.signal)
    progress.totalBytes = opened.totalBytes
    const archive = decompressZstd(opened.stream)
    opened.stream.on('data', (chunk: Buffer) => { progress.bytesRead += chunk.length })
    let dumpDate = dumpDateFromName(source)
    const seen = new Set<string>()
    for await (const entry of readTar(archive)) {
      const file = entry.path.split('/').at(-1)!
      if (file === 'TIMESTAMP') {
        const chunks: Buffer[] = []
        for await (const chunk of entry.body) chunks.push(chunk)
        const stamp = new Date(`${Buffer.concat(chunks).toString('utf8').trim().replace(' ', 'T')}Z`)
        if (!Number.isNaN(stamp.getTime())) dumpDate = stamp
      } else if (file === 'canonical_musicbrainz_data.csv') {
        await copyInto(staging.raw, recordingCopyText(parseCsv(entry.body), progress))
        seen.add(file)
      } else if (file === 'canonical_recording_redirect.csv') {
        await copyInto(staging.redirects, mbidCopyText(parseCsv(entry.body), file, ['canonical_recording_mbid']))
        seen.add(file)
      } else if (file === 'canonical_release_redirect.csv') {
        await copyInto(staging.releases, mbidCopyText(parseCsv(entry.body), file, ['release_mbid', 'release_group_mbid']))
        seen.add(file)
      }
    }
    for (const file of ['canonical_musicbrainz_data.csv', 'canonical_recording_redirect.csv', 'canonical_release_redirect.csv']) {
      if (!seen.has(file)) throw new Error(`The archive has no ${file}; is it a canonical MusicBrainz dump?`)
    }

    progress.phase = 'build'
    await report()
    // Index builds and sorts go much faster with more than Postgres's 64 MB default.
    await run(`set maintenance_work_mem = '256MB'`)
    for (const statement of buildStatements(recordingsPerArtist)) await run(statement)
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
            bytes_read = ${progress.bytesRead}, rows_read = ${progress.rows}
        where id = ${id}`
    })
    return result
  } catch (error) {
    const cancelled = controller.signal.aborted
    await dropStaging(sql).catch(() => {})
    await db.update(catalogIndexImports)
      .set({
        state: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : (error as Error).message,
        finishedAt: new Date(),
        bytesRead: progress.bytesRead,
        rowsRead: progress.rows,
      })
      .where(eq(catalogIndexImports.id, id))
    throw cancelled ? controller.signal.reason : error
  } finally {
    clearInterval(timer)
    opened?.stream.destroy()
    options.signal?.removeEventListener('abort', abort)
    await sql`reset maintenance_work_mem`.catch(() => {})
  }
}

/**
 * Marks imports still `running` as failed when no process holds the import lock: the
 * worker that ran them was killed (OOM, SIGKILL, power loss) before it could record
 * the outcome. Returns whether any row was marked. One statement, so it cannot race an
 * import that is starting: that one takes the lock before it inserts its row.
 */
export async function markInterruptedImports(): Promise<boolean> {
  const rows = await getSql()<{ id: string }[]>`
    update catalog_index_imports
    set state = 'failed', error = 'The import was interrupted', finished_at = now()
    where state = 'running' and not exists (
      select 1 from pg_locks
      where locktype = 'advisory' and objsubid = 1
        and database = (select oid from pg_database where datname = current_database())
        and ((classid::bigint << 32) | objid::bigint) = hashtext(${lockKey})::bigint
    )
    returning id`
  return rows.length > 0
}

/** Asks the running import, in whichever process it runs, to stop. Returns false if none is running. */
export async function cancelImport(): Promise<boolean> {
  // An import whose process died cannot read the request; record it as interrupted instead.
  if (await markInterruptedImports()) return true
  const rows = await db.update(catalogIndexImports)
    .set({ cancelRequested: true })
    .where(eq(catalogIndexImports.state, 'running'))
    .returning({ id: catalogIndexImports.id })
  return rows.length > 0
}
