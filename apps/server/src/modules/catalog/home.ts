import type { HomeResponse, HomeSection } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { getServerSettings } from '../../lib/settings.js'
import { newReleaseAlbumIds } from '../enrichment/releases.js'
import { listPlaylists } from '../userdata/playlists.js'
import { refreshWants, wantedAlbumIds } from '../userdata/wants.js'
import { listLibraryAlbums } from './library.js'
import { albumSummaries, trackSummaries } from './summaries.js'

const RAIL = 20
// Recently played looks at this many latest plays, which bounds the work for heavy listeners.
const RECENT_PLAYS = 500

/**
 * The Home screen, in this order (product decision 30: for someone who streams, what they
 * played is the front page). Section ids are stable; a section without content is left out.
 *
 * - `recently-played`: albums of the user's latest plays.
 * - `most-played`: the user's tracks with the most completed plays over the last 90 days.
 * - `playlists`: the user's own playlists, recently updated first.
 * - `recently-added`: the server's albums (its collection), the newest collection file
 *   first, whatever is in the user's library: Home is where the server's music is found,
 *   and its See all is `/collection/albums`. Music fetched for playing never enters it. It
 *   was the user's library albums while the collection was in every library.
 * - `new-releases`: recent albums by the user's own artists that their library lacks,
 *   newest first (`newReleaseAlbumIds`).
 * - `wantlist`: albums on the user's wantlist, newest first. Only while the wantlist is on.
 */
export async function home(userId: string): Promise<HomeResponse> {
  const { wantlistEnabled } = await getServerSettings()
  if (wantlistEnabled) await refreshWants(userId)
  const [recentlyAdded, recentlyPlayed, mostPlayed, playlists, wanted, newReleases] = await Promise.all([
    listLibraryAlbums(null, { sort: 'recent', limit: RAIL }),
    db.execute<{ id: string }>(sql`
      select recent.album_id as id from (
        select album_id, started_at from plays where user_id = ${userId} and not skipped order by started_at desc limit ${RECENT_PLAYS}
      ) recent
      where recent.album_id is not null
      group by recent.album_id order by max(recent.started_at) desc limit ${RAIL}`).then((rows) => albumSummaries(rows.map((row) => row.id))),
    db.execute<{ id: string; albumId: string | null }>(sql`
      select recording_id as id, (array_agg(album_id order by started_at desc))[1] as "albumId"
      from plays where user_id = ${userId} and completed and not skipped and started_at > now() - interval '90 days'
      group by recording_id order by count(*) desc, max(started_at) desc limit ${RAIL}`).then((rows) => trackSummaries(userId, rows)),
    listPlaylists(userId, { limit: RAIL }, { ownOnly: true }),
    wantlistEnabled ? wantedAlbumIds(userId, RAIL).then(albumSummaries) : [],
    newReleaseAlbumIds(userId, RAIL).then(albumSummaries),
  ])
  const sections: HomeSection[] = [
    { kind: 'albums', id: 'recently-played', title: 'Recently played', albums: recentlyPlayed },
    { kind: 'tracks', id: 'most-played', title: 'Most played', tracks: mostPlayed },
    { kind: 'playlists', id: 'playlists', title: 'Your playlists', playlists: playlists.items },
    { kind: 'albums', id: 'recently-added', title: 'New on this server', albums: recentlyAdded.items },
    { kind: 'albums', id: 'new-releases', title: 'New releases', albums: newReleases },
    { kind: 'albums', id: 'wantlist', title: 'Wantlist', albums: wanted },
  ]
  return { sections: sections.filter((section) => sectionItems(section).length > 0) }
}

function sectionItems(section: HomeSection): unknown[] {
  switch (section.kind) {
    case 'albums': return section.albums
    case 'artists': return section.artists
    case 'tracks': return section.tracks
    case 'playlists': return section.playlists
  }
}
