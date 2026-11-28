/**
 * Smart playlists: rules in place of items, evaluated in SQL on every read so the playlist
 * follows the library (`SmartPlaylistRules` in the contracts says what each rule means).
 *
 * The rules arrive as a zod-validated tree and are compiled into drizzle `sql` fragments.
 * Every value a user typed is a bound parameter; the only text written into the statement is
 * chosen from fixed tables below by an enum the schema already checked, so no rule can change
 * the statement's shape.
 *
 * The query reads the present files of the source (the owner's library, or the server's
 * collection) with their recordings and albums, keeps the files that pass, one per recording,
 * then sorts and cuts. Play counts, last plays, hearts and ratings are joined only when a rule
 * or the sort asks for them. On 150,000 files the whole evaluation is one pass over the files
 * (smart.performance.test.ts checks the plan and the time).
 */
import {
  PLAYLIST_ITEM_LIMIT,
  type SmartCondition, type SmartDateCondition, type SmartGroup, type SmartNumberCondition, type SmartPlaylistRules, type SmartRule,
  type SmartSort, type SmartTextCondition,
} from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { matchKey } from '../../lib/text.js'
import { collectionCounts, collectionFile } from '../catalog/availability.js'

/** What a rule set reads beyond files, recordings and albums. */
type Needs = { plays: boolean; ratings: boolean }

const isGroup = (rule: SmartRule): rule is SmartGroup => 'match' in rule

function conditionsOf(rules: SmartPlaylistRules): SmartCondition[] {
  return rules.conditions.flatMap((rule) => isGroup(rule) ? rule.conditions : [rule])
}

function needsOf(rules: SmartPlaylistRules): Needs {
  const fields = new Set(conditionsOf(rules).map((condition) => condition.field))
  return {
    plays: fields.has('playCount') || fields.has('lastPlayed') || ['mostPlayed', 'leastPlayed', 'recentlyPlayed'].includes(rules.sort),
    ratings: fields.has('rating'),
  }
}

/** Joins conditions with `and` or `or`; an empty list is true either way (no conditions, every song). */
function join(match: 'all' | 'any', parts: SQL[]): SQL {
  if (parts.length === 0) return sql`true`
  return sql`(${sql.join(parts, sql.raw(match === 'all' ? ' and ' : ' or '))})`
}

/**
 * A text test on a `*_key` column, against `matchKey` of the value. Both sides are normalized
 * the same way, so "beyonce" finds "Beyoncé". `contains` is `strpos`, not LIKE, so `%` and `_`
 * in a value are only characters.
 */
function keyTest(column: SQL, op: SmartTextCondition['op'], value: string): SQL {
  const key = matchKey(value)
  return op === 'is' || op === 'isNot' || key === '' ? sql`${column} = ${key}` : sql`strpos(${column}, ${key}) > 0`
}

/** The same on raw text compared lowercase, for genres and codecs, which have no key column. */
function lowerTest(column: SQL, op: SmartTextCondition['op'], value: string): SQL {
  const lowered = value.toLowerCase()
  return op === 'is' || op === 'isNot' ? sql`lower(${column}) = ${lowered}` : sql`strpos(lower(${column}), ${lowered}) > 0`
}

/** The artist half of a `match_key` (`credit|title`), keyed like a name. */
const creditOf = (alias: string) => sql.raw(`split_part(${alias}.match_key, '|', 1)`)

function textCondition(condition: SmartTextCondition): SQL {
  const { op, value } = condition
  let test: SQL
  switch (condition.field) {
    case 'title':
      test = keyTest(sql.raw('r.title_key'), op, value)
      break
    case 'album':
      test = keyTest(sql.raw('a.title_key'), op, value)
      break
    // The artists that match are found once, by name, and kept as a hashed set the files are
    // probed against: one lookup per file would cost more than the whole scan.
    case 'artist':
      // Any credited artist of the song, or its credit as written ("A feat. B").
      test = sql`(r.id in (
        select rule_ra.recording_id from artists rule_ar join recording_artists rule_ra on rule_ra.artist_id = rule_ar.id
        where ${keyTest(sql.raw('rule_ar.name_key'), op, value)}
      ) or ${keyTest(creditOf('r'), op, value)})`
      break
    case 'albumArtist':
      test = sql`(f.album_id in (
        select rule_aa.album_id from artists rule_ar join album_artists rule_aa on rule_aa.artist_id = rule_ar.id
        where ${keyTest(sql.raw('rule_ar.name_key'), op, value)}
      ) or ${keyTest(creditOf('a'), op, value)})`
      break
    case 'genre':
      test = sql`exists (select 1 from unnest(a.genres) as rule_genre(name) where ${lowerTest(sql.raw('rule_genre.name'), op, value)})`
      break
    case 'codec':
      test = lowerTest(sql.raw('f.codec'), op, value)
      break
  }
  // A missing album or artist passes no positive test, so it passes every negative one.
  return op === 'isNot' || op === 'notContains' ? sql`not coalesce(${test}, false)` : sql`coalesce(${test}, false)`
}

/** The value each number field tests, null when unknown (a file with no album has no year). */
const numberColumns: Record<SmartNumberCondition['field'], SQL> = {
  year: sql.raw('a.year'),
  playCount: sql.raw('coalesce(pl.play_count, 0)'),
  rating: sql.raw('coalesce(rt.rating, 0)'),
  durationMs: sql.raw('coalesce(r.duration_ms, f.duration_ms)'),
  // Stored in bits per second; rules speak kbps.
  bitrateKbps: sql.raw('round(f.bitrate / 1000.0)'),
  sampleRateHz: sql.raw('f.sample_rate'),
}

function numberCondition(condition: SmartNumberCondition): SQL {
  const column = numberColumns[condition.field]
  const { value } = condition
  switch (condition.op) {
    case 'eq': return sql`coalesce(${column} = ${value}, false)`
    case 'ne': return sql`(${column} is distinct from ${value})`
    case 'gt': return sql`coalesce(${column} > ${value}, false)`
    case 'lt': return sql`coalesce(${column} < ${value}, false)`
    case 'between': return sql`coalesce(${column} between ${value} and ${condition.to ?? value}, false)`
  }
}

const dateColumns: Record<SmartDateCondition['field'], SQL> = {
  addedAt: sql.raw('f.added_at'),
  lastPlayed: sql.raw('pl.last_played'),
}
const intervals: Record<NonNullable<SmartDateCondition['unit']>, SQL> = {
  days: sql.raw(`interval '1 day'`),
  weeks: sql.raw(`interval '1 week'`),
  months: sql.raw(`interval '1 month'`),
  years: sql.raw(`interval '1 year'`),
}

function dateCondition(condition: SmartDateCondition): SQL {
  const column = dateColumns[condition.field]
  if (condition.op === 'inLast' || condition.op === 'notInLast') {
    const since = sql`(now() - ${Number(condition.value)}::int * ${intervals[condition.unit ?? 'days']})`
    const within = sql`coalesce(${column} >= ${since}, false)`
    return condition.op === 'inLast' ? within : sql`not ${within}`
  }
  const day = sql`(${String(condition.value)}::date at time zone 'UTC')`
  return condition.op === 'before' ? sql`coalesce(${column} < ${day}, false)` : sql`coalesce(${column} >= ${day}, false)`
}

function condition(rule: SmartCondition, ownerId: string): SQL {
  switch (rule.field) {
    case 'title': case 'artist': case 'albumArtist': case 'album': case 'genre': case 'codec':
      return textCondition(rule)
    case 'year': case 'playCount': case 'rating': case 'durationMs': case 'bitrateKbps': case 'sampleRateHz':
      return numberCondition(rule)
    case 'decade': {
      const inDecade = sql`coalesce(a.year between ${rule.value} and ${rule.value + 9}, false)`
      return rule.op === 'is' ? inDecade : sql`not ${inDecade}`
    }
    case 'addedAt': case 'lastPlayed':
      return dateCondition(rule)
    case 'liked': {
      const liked = sql`r.id in (select rule_like.entity_id from likes rule_like where rule_like.user_id = ${ownerId} and rule_like.entity_type = 'recording')`
      return rule.value ? liked : sql`not ${liked}`
    }
    case 'lossless':
      return rule.value ? sql`f.lossless` : sql`not f.lossless`
  }
}

/** The whole rule tree as one condition over `f` (file), `r` (recording), `a` (album), `pl` and `rt`. */
export function compileConditions(rules: SmartPlaylistRules, ownerId: string): SQL {
  return join(rules.match, rules.conditions.map((rule) => isGroup(rule)
    ? join(rule.match, rule.conditions.map((inner) => condition(inner, ownerId)))
    : condition(rule, ownerId)))
}

/**
 * Condition: the file (`f`, present) makes its recording a member of the owner's library, the
 * three ways in of `libraryRecordingIds` (catalog/library.ts) tested on the file itself: a
 * collection file while the collection counts for the owner, a file of a recording they
 * hearted, or a file on an album they hearted. A recording is in the library exactly when one
 * of its present files passes (`inLibraryRecording`), and testing the file needs no lookup per
 * row: the saves are two hashed sets and `collectionCounts` runs once.
 */
function libraryFile(ownerId: string): SQL {
  return sql`((${collectionCounts(ownerId)} and ${collectionFile('f')})
    or r.id in (select saved.entity_id from likes saved where saved.user_id = ${ownerId} and saved.entity_type = 'recording')
    or f.album_id in (select saved.entity_id from likes saved where saved.user_id = ${ownerId} and saved.entity_type = 'album'))`
}

/**
 * Each order: the columns it sorts by (computed in the inner query, once per song, and only for
 * the order asked) and its keys over them. The recording id breaks ties.
 */
const orders: Record<SmartSort, { columns: string[]; keys: string }> = {
  random: { columns: ['shuffle'], keys: 'm.shuffle, m.id' },
  mostPlayed: { columns: ['play_count', 'last_played'], keys: 'm.play_count desc, m.last_played desc nulls last, m.id' },
  leastPlayed: { columns: ['play_count', 'last_played'], keys: 'm.play_count, m.last_played nulls first, m.id' },
  // Songs that arrived together (one album) keep their track order: the file paths.
  recentlyAdded: { columns: ['path'], keys: 'm.added_at desc, m.path, m.id' },
  recentlyPlayed: { columns: ['last_played'], keys: 'm.last_played desc nulls last, m.id' },
  title: { columns: ['title_sort', 'credit_sort'], keys: 'm.title_sort, m.credit_sort, m.id' },
  artist: { columns: ['credit_sort', 'year', 'album_sort', 'path'], keys: 'm.credit_sort, m.year nulls last, m.album_sort, m.path, m.id' },
  year: { columns: ['year', 'album_sort', 'path'], keys: 'm.year desc nulls last, m.album_sort, m.path, m.id' },
}

/** The expression behind each sort column; `pl` exists whenever an order that reads plays is asked for. */
const sortColumns: Record<string, (seed: string) => SQL> = {
  shuffle: (seed) => sql`md5(r.id::text || ${seed})`,
  play_count: () => sql.raw('coalesce(pl.play_count, 0)'),
  last_played: () => sql.raw('pl.last_played'),
  path: () => sql.raw('f.rel_path'),
  title_sort: () => sql.raw(`regexp_replace(r.title_key, '^(the|a|an) ', '')`),
  credit_sort: () => sql.raw(`regexp_replace(split_part(r.match_key, '|', 1), '^(the|a|an) ', '')`),
  album_sort: () => sql.raw(`regexp_replace(a.title_key, '^(the|a|an) ', '')`),
  year: () => sql.raw('a.year'),
}

export type SmartTrackRow = { id: string; albumId: string | null; addedAt: string; durationMs: number }

/**
 * The songs of a smart playlist, in order: `id`, the album of the file that placed it,
 * `addedAt` (that file's arrival) and duration. `seed` fixes the random order. Exported for
 * EXPLAIN in tests.
 */
export function smartTracksQuery(ownerId: string, rules: SmartPlaylistRules, seed: string): SQL {
  const needs = needsOf(rules)
  const source = rules.source === 'server' ? collectionFile('f') : libraryFile(ownerId)
  const limit = Math.min(rules.limit ?? PLAYLIST_ITEM_LIMIT, PLAYLIST_ITEM_LIMIT)
  const order = orders[rules.sort]
  return sql`
    select m.id, m.album_id as "albumId", to_char(m.added_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "addedAt",
      m.duration_ms as "durationMs"
    from (
      -- One file per song: of those that pass, the newest. The rows stay narrow, so the sort
      -- that picks them stays in memory.
      select distinct on (f.recording_id) f.recording_id as id, f.album_id, f.added_at,
        coalesce(r.duration_ms, f.duration_ms, 0) as duration_ms
        ${sql.join(order.columns.map((column) => sql`, ${sortColumns[column]!(seed)} as ${sql.raw(column)}`))}
      from media_files f
      join recordings r on r.id = f.recording_id
      left join albums a on a.id = f.album_id
      ${needs.plays ? sql`left join (
        select p.recording_id, count(*) filter (where p.completed)::int as play_count, max(p.started_at) as last_played
        from plays p where p.user_id = ${ownerId} group by p.recording_id
      ) pl on pl.recording_id = r.id` : sql``}
      ${needs.ratings ? sql`left join ratings rt on rt.user_id = ${ownerId} and rt.entity_type = 'recording' and rt.entity_id = r.id` : sql``}
      where f.missing_since is null and ${source} and ${compileConditions(rules, ownerId)}
      order by f.recording_id, f.added_at desc, f.id desc
    ) m
    order by ${sql.raw(order.keys)}
    limit ${limit}`
}

/** The day's shuffle of a playlist: the same for every reader until midnight UTC. */
export function dailySeed(playlistId: string, now = new Date()): string {
  return `${playlistId}:${now.toISOString().slice(0, 10)}`
}

/**
 * A smart playlist's songs for its owner, in order. The statement sorts every song that passes,
 * which on a large library is more than the default `work_mem` holds; it gets more for itself
 * alone rather than spill to disk.
 */
export async function smartTracks(ownerId: string, rules: SmartPlaylistRules, seed: string): Promise<SmartTrackRow[]> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set local work_mem = '32MB'`)
    return tx.execute<SmartTrackRow>(smartTracksQuery(ownerId, rules, seed))
  })
  return rows.map((row) => ({ ...row, durationMs: Number(row.durationMs) }))
}
