/**
 * Deezer's radio of an artist as catalog rows, for the radio module's suggestions.
 *
 * Deezer's artist radio mixes a few of the artist's tracks with popular tracks of artists
 * like it. Its tracks become rows the way an artist page's popular tracks do
 * (deezer-rows.ts): the row already carrying the Deezer id, ISRC or the artist's title,
 * else a provider-only stub with its album as the hint; the artists it names get rows the
 * same way. That is what lets a radio reach artists the catalog has never heard of, on a
 * server that holds a few hundred files.
 *
 * The artist's Deezer id is the one linked in `external_ids`, else the hit of an
 * exact-name search, as similar artists do (radio/similar.ts). The search hit is not
 * linked here: a name alone does not prove it is the same artist. The artist's own tracks
 * in the radio then get their artist row by `deezerArtistRow`'s rule, like search results.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { artists, externalIds } from '../../database/schema.js'
import { getServerSettings } from '../../lib/settings.js'
import { matchKey } from '../../lib/text.js'
import { resolveMerged } from '../catalog/redirects.js'
import { deezer } from '../metadata/index.js'
import { deezerRadioTrackRow } from './deezer-rows.js'
import { currentId, externalIdOf } from './rows.js'

/**
 * How long one artist's rows are reused before Deezer's answer (cached for a day) is read
 * and its rows looked up again. Autoplay asks on every batch.
 */
const REUSE_MS = 60 * 60_000
/** Artists whose rows are kept for reuse; the oldest goes first. */
const KEPT = 500

/** A run writing one artist's radio rows: those written so far, in Deezer's order, and the end. */
type Run = { written: (string | null)[]; done: Promise<string[]> }

const kept = new Map<string, { at: number; ids: string[] }>()
const running = new Map<string, Run>()

async function deezerIdOf(artistId: string): Promise<string | null> {
  const linked = await externalIdOf('deezer', 'artist', artistId)
  if (linked) return linked
  const [artist] = await db.select({ name: artists.name, nameKey: artists.nameKey }).from(artists).where(eq(artists.id, artistId))
  if (!artist) return null
  const found = await deezer.search(artist.name, { types: ['artist'], limit: 5 })
  const hit = found.artists.find((candidate) => matchKey(candidate.name) === artist.nameKey)
  return hit ? String(hit.id) : null
}

/** Recordings already carrying the Deezer track ids, after merges. */
async function linkedRecordings(trackIds: readonly number[]): Promise<Map<string, string>> {
  if (trackIds.length === 0) return new Map()
  const rows = await db.select({ externalId: externalIds.externalId, entityId: externalIds.entityId }).from(externalIds)
    .where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityType, 'recording'), inArray(externalIds.externalId, trackIds.map(String))))
  const resolved = await resolveMerged('recordings', rows.map((row) => row.entityId))
  return new Map(rows.map((row) => [row.externalId, resolved.get(row.entityId) ?? row.entityId]))
}

async function load(artistId: string, written: (string | null)[]): Promise<string[]> {
  // Autoplay asks on every batch: with Deezer off, not even the artist's row is read.
  if (!(await getServerSettings()).deezerEnabled) return []
  const id = await currentId('artist', artistId)
  if (!id) return []
  const deezerId = await deezerIdOf(id)
  if (!deezerId) return []
  const tracks = await deezer.getArtistRadio(Number(deezerId))
  // Tracks a page or an earlier radio wrote need no transaction: on a later visit that is all of them.
  const known = await linkedRecordings(tracks.map((track) => track.id))
  written.push(...tracks.map((track) => known.get(String(track.id)) ?? null))
  // One at a time: each takes the upsert lock, and concurrent ones would only queue on it.
  for (const [index, track] of tracks.entries()) written[index] ??= await deezerRadioTrackRow(track)
  return [...new Set(written.filter((one): one is string => one !== null))]
}

/**
 * The recordings of Deezer's radio of the artist, in its order. Empty when Deezer is off
 * or does not know the artist. Concurrent callers share one run. With `waitMs`, a run
 * still writing rows by then answers with the rows written so far and carries on, so the
 * next call has the rest.
 */
export async function artistRadioRows(artistId: string, { waitMs }: { waitMs?: number } = {}): Promise<string[]> {
  const reuse = kept.get(artistId)
  if (reuse && Date.now() - reuse.at < REUSE_MS) return reuse.ids
  let run = running.get(artistId)
  if (!run) {
    const written: (string | null)[] = []
    const done = load(artistId, written).then((ids) => {
      // An empty answer is not kept: Deezer may be switched on, or know the artist, later.
      if (ids.length > 0) {
        kept.delete(artistId)
        kept.set(artistId, { at: Date.now(), ids })
        if (kept.size > KEPT) kept.delete(kept.keys().next().value!)
      }
      return ids
    }).finally(() => running.delete(artistId))
    run = { written, done }
    running.set(artistId, run)
  }
  if (waitMs === undefined) return run.done
  const current = run
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs) })
  // Whoever gives up waiting must not leave the run's failure unhandled.
  current.done.catch(() => {})
  const finished = await Promise.race([current.done, deadline]).finally(() => clearTimeout(timer))
  return finished ?? [...new Set(current.written.filter((one): one is string => one !== null))]
}
