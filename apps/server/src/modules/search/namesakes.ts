/**
 * Keeps one artist of a name in a catalog answer. Deezer has duplicate pages for some
 * artists ("Boards of Canada" is 1098 and 412310471), and materialize.ts stores an id it
 * does not know as an artist of its own when the artist of that name already has another
 * Deezer id, since namesakes are real. Enrichment merges such a row into the MusicBrainz
 * artist once a bridge is sure (enrichment/namesakes.ts), but a bridge is not always sure:
 * MusicBrainz itself has a second "Boards of Canada" for mistagged releases. Shown side by
 * side, the two look like the same artist twice, and the stub's page is nearly empty.
 */
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { uuidArray } from '../catalog/sql.js'

/**
 * `catalog` in order, without each artist that has no MusicBrainz id and the name of an
 * artist the library answer lists, of a catalog artist that has an MBID, or of an earlier
 * catalog artist. Artists with MBIDs always stay: two of them are two artists.
 */
export async function withoutNamesakes(catalog: readonly string[], library: readonly string[]): Promise<string[]> {
  if (catalog.length === 0) return []
  const rows = await db.execute<{ id: string; nameKey: string; mbid: string | null }>(sql`
    select id, name_key as "nameKey", mbid from artists where id = any(${uuidArray([...catalog, ...library])})`)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const taken = new Set(library.flatMap((id) => (byId.has(id) ? [byId.get(id)!.nameKey] : [])))
  for (const id of catalog) if (byId.get(id)?.mbid) taken.add(byId.get(id)!.nameKey)
  const kept: string[] = []
  for (const id of catalog) {
    const row = byId.get(id)
    if (row && !row.mbid) {
      if (taken.has(row.nameKey)) continue
      taken.add(row.nameKey)
    }
    kept.push(id)
  }
  return kept
}
