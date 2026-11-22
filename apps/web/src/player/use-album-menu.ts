import type { AlbumSummary, TrackSummary } from '@squirmy/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { errorMessage } from '@/api/errors'
import { albumQuery } from '@/api/queries'
import { useApi } from '@/api/services'
import { albumMenuEntries } from '@/components/music/album-menu'
import { albumPresentation, isPlayable } from '@/lib/catalog'
import { toast } from '@/lib/toast'
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

  const withTracks = async (then: (tracks: TrackSummary[]) => void) => {
    try {
      const loaded = await queryClient.fetchQuery(albumQuery(api, album.id))
      then(loaded.discs.flatMap(disc => disc.tracks))
    } catch (error) {
      toast({ title: errorMessage(error) })
    }
  }
  const wanted = library.isWanted(album.id, detail?.wanted)

  const entries = albumMenuEntries({
    artists: album.artists,
    playable: !dimmed,
    onPlay: onPlay ?? (() => void playAlbum(album)),
    onEnqueue: placement => void withTracks(tracks => {
      controls.enqueue(tracks.filter(track => isPlayable(track, viewer)), placement)
      toast({ title: placement === 'next' ? 'Playing next' : 'Added to queue', description: album.title })
    }),
    playlists: library.playlists,
    onAddToPlaylist: playlist => void withTracks(tracks => (playlist ? library.addToPlaylist(playlist, tracks) : library.newPlaylist(tracks))),
    liked: detail?.liked,
    onToggleSaved: () => { if (detail) library.setSaved({ type: 'album', id: album.id, title: album.title }, !detail.liked) },
    want: library.wantlistEnabled && dimmed
      ? {
          wanted,
          onToggle: () => {
            library.setWanted({ type: 'album', album }, !wanted)
            toast({ title: wanted ? 'Removed from Wantlist' : 'Added to Wantlist', description: album.title })
          },
        }
      : undefined,
    onGoToArtist: artist => void navigate(`/artist/${artist.id}`),
  })
  return { entries, onOpenChange: setOpen }
}
