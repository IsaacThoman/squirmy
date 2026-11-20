import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { artists, externalIds } from '../../database/schema.js'
import { matchKey } from '../../lib/text.js'
import { uuidArray } from '../catalog/sql.js'
import { deezer, listenbrainz } from '../metadata/index.js'

/** A catalog artist similar to another, with a score from 0 (barely) to 1 (most similar). */
export type SimilarArtist = { artistId: string; name: string; score: number }

/** One source's answer: an artist it names, and how similar (0..1) it ranks it. */
type Suggested = { mbid: string | null; name: string; score: number }

type Artist = { id: string; name: string; mbid: string | null; nameKey: string }

/** Deezer's related artists, ranked by position. Resolves the Deezer id from `external_ids`, else by exact name. */
async function fromDeezer(artist: Artist): Promise<Suggested[]> {
  const [known] = await db.select({ externalId: externalIds.externalId }).from(externalIds)
    .where(and(eq(externalIds.provider, 'deezer'), eq(externalIds.entityType, 'artist'), eq(externalIds.entityId, artist.id)))
  let deezerId = known ? Number(known.externalId) : null
  if (!deezerId) {
    const found = await deezer.search(artist.name, { types: ['artist'], limit: 5 })
    deezerId = found.artists.find((candidate) => matchKey(candidate.name) === artist.nameKey)?.id ?? null
  }
  if (!deezerId) return []
  const related = await deezer.getRelatedArtists(deezerId, { limit: 20 })
  return related.map((one, index) => ({ mbid: null, name: one.name, score: 1 - index / related.length }))
}

/** ListenBrainz's session-based similar artists, scored relative to the best match. Needs the artist's MBID. */
async function fromListenBrainz(artist: Artist): Promise<Suggested[]> {
  if (!artist.mbid) return []
  const similar = await listenbrainz.similarArtists(artist.mbid, { limit: 25 })
  const best = Math.max(...similar.map((one) => one.score), 1)
  return similar.map((one) => ({ mbid: one.mbid, name: one.name, score: one.score / best }))
}

/**
 * Artists similar to a catalog artist, most similar first, from Deezer's related
 * artists and (when the operator set a token) ListenBrainz. Each source's answers are
 * mapped back to catalog artists by MBID, else by `name_key`, preferring artists with
 * music in the library; artists missing from the catalog are left out. Sources that
 * are off or fail are skipped, so the result may be empty but the call does not throw.
 * An artist both sources name ranks above one only a single source names.
 */
export async function similarArtists(artistId: string, options: { limit?: number } = {}): Promise<SimilarArtist[]> {
  const [artist] = await db.select({ id: artists.id, name: artists.name, mbid: artists.mbid, nameKey: artists.nameKey })
    .from(artists).where(eq(artists.id, artistId))
  if (!artist) return []
  const answers = (await Promise.all([fromDeezer(artist), fromListenBrainz(artist)].map((source) => source.catch(() => []))))
    .filter((answer) => answer.length > 0)
  if (answers.length === 0) return []

  const mbids = [...new Set(answers.flat().flatMap((one) => (one.mbid ? [one.mbid] : [])))]
  const keys = [...new Set(answers.flat().map((one) => matchKey(one.name)))]
  const rows = await db.execute<{ id: string; name: string; mbid: string | null; nameKey: string }>(sql`
    select a.id, a.name, a.mbid::text as mbid, a.name_key as "nameKey" from artists a
    where a.merged_into_id is null and a.id <> ${artist.id}
      and (a.mbid = any(${uuidArray(mbids)}) or a.name_key = any(${`{${keys.map((key) => JSON.stringify(key)).join(',')}}`}::text[]))
    order by exists (
      select 1 from album_artists aa join media_files mf on mf.album_id = aa.album_id
      where aa.artist_id = a.id and mf.missing_since is null
    ) desc, a.id`)
  const byMbid = new Map(rows.flatMap((row) => (row.mbid ? [[row.mbid, row] as const] : [])))
  const byKey = new Map<string, (typeof rows)[number]>()
  for (const row of rows) if (!byKey.has(row.nameKey)) byKey.set(row.nameKey, row)

  const scores = new Map<string, SimilarArtist>()
  for (const answer of answers) {
    const seen = new Set<string>()
    for (const one of answer) {
      const key = matchKey(one.name)
      // A name match is a different artist when both sides have MBIDs and they differ.
      const byName = byKey.get(key)
      const row = (one.mbid ? byMbid.get(one.mbid) : undefined) ?? (byName && !(one.mbid && byName.mbid && byName.mbid !== one.mbid) ? byName : undefined)
      if (!row || seen.has(row.id)) continue
      seen.add(row.id)
      const entry = scores.get(row.id) ?? { artistId: row.id, name: row.name, score: 0 }
      entry.score += one.score / answers.length
      scores.set(row.id, entry)
    }
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, options.limit ?? 25)
}
