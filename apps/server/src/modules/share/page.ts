import type { PublicShare, PublicShareTrack, TrackSummary } from '@squirmy/contracts'
import { getServerSettings } from '../../lib/settings.js'
import { explicitAllowed } from '../catalog/explicit.js'
import { resolveOne } from '../catalog/redirects.js'
import { albumSummaries, alignedTrackSummaries } from '../catalog/summaries.js'
import { playlistSummaries } from '../userdata/playlists.js'
import { shareNotFound, shareTracks, type ShareRow } from './links.js'

/**
 * A song as the public page shows it: what is printed on a record sleeve, and whether it plays.
 * Built field by field, so nothing a summary gains later (hearts, library state, credits with
 * artist ids) reaches people without an account.
 */
function publicTrack(track: TrackSummary, place: { disc: number | null; position: number | null }, onAlbum: boolean, allowsExplicit: boolean): PublicShareTrack {
  return {
    id: track.id,
    title: track.title,
    artistCredit: track.artistCredit,
    albumTitle: onAlbum ? null : track.album?.title ?? null,
    artwork: onAlbum ? null : track.album?.artwork ?? null,
    durationMs: track.durationMs,
    disc: onAlbum ? place.disc : null,
    position: onAlbum ? place.position : null,
    explicit: track.explicit,
    // Only music the server holds. A song a provider could fetch is not fetched for strangers.
    // An explicit song its creator may not play is gray here too, as it is for them.
    available: track.availability === 'server' && (allowsExplicit || track.explicit !== true),
  }
}

/** `GET /share/:token`: the page for a live link. */
export async function publicShare(share: ShareRow): Promise<PublicShare> {
  const settings = await getServerSettings()
  const refs = await shareTracks(share)
  // Summaries as the creator sees them; only the fields `publicTrack` copies leave the server.
  const summaries = await alignedTrackSummaries(share.userId, refs)
  const allowsExplicit = await explicitAllowed(share.userId)
  const onAlbum = share.kind === 'album'
  const tracks = refs.flatMap((ref, index) => {
    const summary = summaries[index]
    return summary ? [publicTrack(summary, ref, onAlbum, allowsExplicit)] : []
  })
  const durationMs = tracks.reduce((sum, track) => sum + track.durationMs, 0)
  const common = { tracks, durationMs, playback: settings.sharePlayback, expiresAt: share.expiresAt?.toISOString() ?? null, serverName: settings.serverName }

  if (share.kind === 'album') {
    const albumId = (await resolveOne('albums', share.albumId!)) ?? share.albumId!
    const [album] = await albumSummaries([albumId])
    if (!album) throw shareNotFound()
    return { kind: 'album', title: album.title, artistCredit: album.artistCredit, year: album.year, artwork: album.artwork, ...common }
  }
  if (share.kind === 'playlist') {
    const [playlist] = await playlistSummaries([share.playlistId!])
    if (!playlist) throw shareNotFound()
    // The name the owner gave it, and its cover; not who owns it.
    return { kind: 'playlist', title: playlist.name, artistCredit: null, year: null, artwork: playlist.artworks[0] ?? null, ...common }
  }
  const [track] = summaries
  if (!track) throw shareNotFound()
  const [album] = track.album ? await albumSummaries([track.album.id]) : []
  return { kind: 'track', title: track.title, artistCredit: track.artistCredit, year: album?.year ?? null, artwork: track.album?.artwork ?? null, ...common }
}
