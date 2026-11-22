/**
 * Artists only Deezer knows that share their name with another artist row. Deezer has
 * duplicate pages for some artists ("Boards of Canada" is 1098 and 412310471, "Daft Punk"
 * 27 and 412557421), and search stores a Deezer id it does not know as an artist of its
 * own when the artist of that name already has another Deezer id, because namesakes are
 * real (materialize.ts). Opening such a row's page bridges it to MusicBrainz and merges it
 * into the artist that has the MBID; until then search showed the same artist twice.
 *
 * `bridgeNamesakes` does that bridge for rows nobody opened: the MusicBrainz URL relation of
 * the Deezer page, else an unambiguous exact-name search (bridge.ts), and nothing else, so
 * a real namesake stays apart. A bridged row adopts the MBID, or is merged into the row
 * that has it. Each row is tried once a day per process; the sweep runs it.
 */
import { queryKeys } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { bridgeArtist } from './bridge.js'
import { adoptMbidNow, attempt, changed } from './rows.js'

/** Rows looked at per run: each costs one or two MusicBrainz requests, a second apart. */
const batch = 20
const retryMs = 24 * 60 * 60_000
const triedAt = new Map<string, number>()

/** Forgets which rows were tried, for tests. */
export function resetNamesakes() {
  triedAt.clear()
}

/** Bridges up to {@link batch} Deezer-only artists that share a name with another row. Returns the ids of those that took an MBID. */
export async function bridgeNamesakes(): Promise<string[]> {
  const now = Date.now()
  for (const [id, at] of triedAt) if (at < now - retryMs) triedAt.delete(id)
  const rows = await db.execute<{ id: string; name: string; deezerId: string }>(sql`
    select ar.id, ar.name, e.external_id as "deezerId" from artists ar
    join lateral (select external_id from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = ar.id
      order by e.external_id limit 1) e on true
    where ar.mbid is null and ar.merged_into_id is null
      and exists (select 1 from artists other where other.name_key = ar.name_key and other.id <> ar.id and other.merged_into_id is null)
    order by ar.id limit ${batch + triedAt.size}`)
  const bridged: string[] = []
  for (const row of rows.filter((one) => !triedAt.has(one.id)).slice(0, batch)) {
    triedAt.set(row.id, now)
    await attempt(`bridge ${row.name}`, async () => {
      const mbid = await bridgeArtist(row.deezerId, row.name)
      if (!mbid) return
      const into = await adoptMbidNow('artist', row.id, mbid)
      bridged.push(row.id)
      await changed([queryKeys.artist(row.id), queryKeys.artist(into)])
    })
  }
  return bridged
}
