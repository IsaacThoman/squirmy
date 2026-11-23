import type { AlbumSummary, TrackSummary } from '@squirmy/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { albumQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import { albumMenuEntries } from '@/components/music/album-menu'
import { albumPresentation, isPlayable } from '@/lib/catalog'
import { useLibrary } from './library-context'
import { useViewer } from './on-demand-context'
import { usePlayerControls } from './player-context'
import { usePlayCollections } from './use-play-collections'

/**
 * The album page's menu for a card or row that has only the album's summary. What needs the
 * songs loads the album first (from the cache when the card was hovered); whether it is saved
 * is read from the album once the menu opens.
 */
export function useAlbumMenu(album: AlbumSummary, onPlay?: () => void) {
  const api = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const library = useLibrary()
  const viewer = useViewer()
  const controls = usePlayerControls()
  const { playAlbum } = usePlayCollections()
  const [open, setOpen] = useState(false)
  const detail = useQuery({ ...albumQuery(api, album.id), enabled: open }).data
  const dimmed = albumPresentation(album, viewer) === 'dimmed'

  // The entry waits for the album's songs, and says on itself when they did not load.
  const withTracks = async <T,>(then: (tracks: TrackSummary[]) => T) => {
    const loaded = await queryClient.fetchQuery(albumQuery(api, album.id))
    return then(loaded.discs.flatMap(disc => disc.tracks))
  }
  const wanted = library.isWanted(album.id, detail?.wanted)

  const entries = albumMenuEntries({
    artists: album.artists,
    playable: !dimmed,
    onPlay: onPlay ?? (() => void playAlbum(album)),
    onEnqueue: placement => withTracks(tracks => controls.enqueue(tracks.filter(track => isPlayable(track, viewer)), placement)),
    playlists: library.playlists,
    onAddToPlaylist: playlist => withTracks(tracks => {
      if (playlist) return library.addToPlaylist(playlist, tracks)
      library.newPlaylist(tracks)
      return false
    }),
    liked: detail?.liked,
    onToggleSaved: () => (detail ? library.setSaved({ type: 'album', id: album.id, title: album.title }, !detail.liked) : undefined),
    want: library.wantlistEnabled && dimmed ? { wanted, onToggle: () => library.setWanted({ type: 'album', album }, !wanted) } : undefined,
    onGoToArtist: artist => void navigate(`/artist/${artist.id}`),
  })
  return { entries, onOpenChange: setOpen }
}
