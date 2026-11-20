/**
 * Switching a metadata source on leaves music enriched while it was off without what that
 * source adds. `markEnrichmentStale` marks that work as not done, and `enrichment.sweep`
 * redoes it in its usual batches, so nothing is re-enriched all at once:
 * - owned albums lose `enriched_at` when a source of covers, Deezer ids or descriptions
 *   comes on (MusicBrainz, Cover Art Archive, Deezer, Wikidata);
 * - artists credited on owned albums drop from `detail_level` 2 to 1, with no fetch time,
 *   when a source of images, bios, top tracks or popularity comes on (MusicBrainz, Deezer,
 *   Wikidata, a fanart.tv key, a ListenBrainz token).
 * Lyrics need nothing: no LRCLIB lookup is made or remembered while it is off, so the
 * sweep finds the recordings without lyrics once it is back on.
 */
import type { ServerSettings } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'

type Source = keyof Pick<ServerSettings,
  'musicBrainzEnabled' | 'coverArtArchiveEnabled' | 'deezerEnabled' | 'wikidataEnabled' | 'fanartKeySet' | 'listenBrainzTokenSet'>

const albumSources: Source[] = ['musicBrainzEnabled', 'coverArtArchiveEnabled', 'deezerEnabled', 'wikidataEnabled']
const artistSources: Source[] = ['musicBrainzEnabled', 'deezerEnabled', 'wikidataEnabled', 'fanartKeySet', 'listenBrainzTokenSet']

/** Marks the enrichment the sources switched on between `before` and `after` would change. */
export async function markEnrichmentStale(before: ServerSettings, after: ServerSettings): Promise<void> {
  const switchedOn = (sources: Source[]) => sources.some((source) => !before[source] && after[source])
  if (switchedOn(albumSources)) {
    await db.execute(sql`
      update albums a set enriched_at = null
      where a.enriched_at is not null and exists (select 1 from media_files f where f.album_id = a.id and f.missing_since is null)`)
  }
  if (switchedOn(artistSources)) {
    await db.execute(sql`
      update artists ar set detail_level = 1, fetched_at = null
      where ar.detail_level >= 2
        and exists (select 1 from album_artists aa join media_files f on f.album_id = aa.album_id and f.missing_since is null where aa.artist_id = ar.id)`)
  }
}
