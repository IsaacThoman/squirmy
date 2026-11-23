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
import { eq, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { artists } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { matchKey } from '../../lib/text.js'
import { lockUpserts } from '../matching/apply.js'
import { deezer, musicbrainz } from '../metadata/index.js'
import { bridgeArtist, contradictsHint, nameHint } from './bridge.js'
import { reconcileArtistAlbums } from './reconcile.js'
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
      // The merged row's album stubs now sit beside the artist's release groups.
      if (into !== row.id) await reconcileArtistAlbums(into)
      bridged.push(row.id)
      await changed([queryKeys.artist(row.id), queryKeys.artist(into)])
    })
  }
  return bridged
}

/** A disambiguation that says the artist plays someone else's music. */
const playsOthers = /\b(tribute|cover band|covers band|karaoke|impersonat)/i

/** Rows looked at per repair run: each costs a MusicBrainz request (a second) and a Deezer one per page. */
const unlinkBatch = 100

/**
 * Undoes bridges that linked an artist row to the wrong MusicBrainz artist by name: the
 * row's Deezer page carries a namesake hint the MusicBrainz artist does not fit ("Nirvana
 * (UK)", the 1970s band, became "Nirvana UK", a tribute band), or the MusicBrainz artist is
 * a tribute or cover act while the page is not. A page MusicBrainz itself links to the
 * artist is never doubted. The MBID goes to a row of its own with what MusicBrainz credits
 * to it; the row keeps its Deezer page, albums and likes, takes the page's name back, and
 * is bridged again the next time it is enriched (with `confidentArtist`'s hint rules).
 * Candidates are artists whose MusicBrainz name ends in a country word or whose
 * disambiguation says they play others' music. Returns how many were unlinked; running it
 * again changes nothing.
 */
export async function unlinkContradictedBridges(): Promise<number> {
  const rows = await db.execute<{ id: string; mbid: string }>(sql`
    select a.id, a.mbid from artists a
    where a.mbid is not null and a.merged_into_id is null
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = a.id)
      and (a.disambiguation ~* '(tribute|cover band|covers band|karaoke|impersonat)'
        or a.name ~* '\\s(uk|us|usa|gb|ca|au|fr|de|jp|kr)$')
    order by md5(a.id::text || current_date::text) limit ${unlinkBatch}`)
  let unlinked = 0
  for (const row of rows) {
    await attempt(`check bridge ${row.id}`, async () => {
      const artist = await musicbrainz.getArtist(row.mbid)
      if (!artist) return
      const linkedPages = new Set(artist.urls.flatMap((link) => /deezer\.com\/(?:[a-z]{2}\/)?artist\/(\d+)/.exec(link.url)?.[1] ?? []))
      const pages = await db.execute<{ id: string }>(sql`
        select external_id as id from external_ids where provider = 'deezer' and entity_type = 'artist' and entity_id = ${row.id}`)
      let wrongPage: string | null = null
      for (const page of pages) {
        if (linkedPages.has(page.id)) return
        const deezerArtist = await deezer.getArtist(Number(page.id))
        if (!deezerArtist) continue
        if (contradictsHint(artist, deezerArtist.name) || (playsOthers.test(artist.disambiguation) && !playsOthers.test(deezerArtist.name))) {
          wrongPage = deezerArtist.name
        }
      }
      if (!wrongPage) return
      const name = wrongPage
      await db.transaction(async (tx) => {
        await lockUpserts(tx)
        const [current] = await tx.select({ mbid: artists.mbid }).from(artists).where(eq(artists.id, row.id))
        if (current?.mbid !== row.mbid) return
        // What MusicBrainz credits to its artist goes with the MBID to a row of its own.
        const own = newId()
        await tx.update(artists).set({ mbid: null, updatedAt: new Date() }).where(eq(artists.id, row.id))
        await tx.insert(artists).values({
          id: own, mbid: row.mbid, name: artist.name, sortName: artist.sortName, nameKey: matchKey(artist.name), disambiguation: artist.disambiguation || null,
          country: artist.country, detailLevel: 1,
        })
        await tx.execute(sql`
          update album_artists aa set artist_id = ${own} from albums al
          where aa.album_id = al.id and aa.artist_id = ${row.id} and al.mbid is not null`)
        await tx.execute(sql`
          update recording_artists ra set artist_id = ${own} from recordings r
          where ra.recording_id = r.id and ra.artist_id = ${row.id} and r.mbid is not null`)
        await tx.execute(sql`update albums set primary_artist_id = ${own} where primary_artist_id = ${row.id} and mbid is not null`)
        await tx.execute(sql`update recordings set primary_artist_id = ${own} where primary_artist_id = ${row.id} and mbid is not null`)
        await tx.update(artists).set({
          name, sortName: name, nameKey: matchKey(name), disambiguation: null, country: null, detailLevel: 0, fetchedAt: null, updatedAt: new Date(),
        }).where(eq(artists.id, row.id))
      })
      unlinked++
      await changed([queryKeys.artist(row.id)])
    })
  }
  return unlinked + await restoreHintedNames()
}

/**
 * A row without an MBID that still carries the name a wrong bridge gave it ("Nirvana UK"
 * for Deezer's "Nirvana (UK)"): bridging again by that name found the same wrong artist,
 * so the row takes its Deezer page's name back, hint and all. Returns how many.
 */
async function restoreHintedNames(): Promise<number> {
  const rows = await db.execute<{ id: string; name: string }>(sql`
    select a.id, a.name from artists a
    where a.mbid is null and a.merged_into_id is null and a.name ~* '\\s(uk|us|usa|gb|ca|au|fr|de|jp|kr)$'
      and exists (select 1 from external_ids e where e.provider = 'deezer' and e.entity_type = 'artist' and e.entity_id = a.id)
    order by a.id limit ${unlinkBatch}`)
  let restored = 0
  for (const row of rows) {
    await attempt(`restore name ${row.id}`, async () => {
      const pages = await db.execute<{ id: string }>(sql`
        select external_id as id from external_ids where provider = 'deezer' and entity_type = 'artist' and entity_id = ${row.id} order by external_id`)
      for (const page of pages) {
        const deezerArtist = await deezer.getArtist(Number(page.id))
        if (!deezerArtist || !nameHint(deezerArtist.name) || matchKey(deezerArtist.name) !== matchKey(row.name) || deezerArtist.name === row.name) continue
        await db.update(artists).set({ name: deezerArtist.name, sortName: deezerArtist.name, nameKey: matchKey(deezerArtist.name), fetchedAt: null, updatedAt: new Date() })
          .where(eq(artists.id, row.id))
        restored++
        await changed([queryKeys.artist(row.id)])
        return
      }
    })
  }
  return restored
}
