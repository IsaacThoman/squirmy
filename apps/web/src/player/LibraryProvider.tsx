import { queryKeys, type CreatePlaylistRequest, type LikeEntityType, type Page, type PlaylistSummary, type TrackSummary, type WantItem } from '@squirmy/contracts'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { patchEntity } from '@/api/patch'
import { usePlaylists, useWants } from '@/api/queries'
import { useApi } from '@/api/services'
import { useCurrentUser, useWantlistEnabled } from '@/auth/session'
import { PlaylistDialog } from '@/components/layout/PlaylistDialog'
import { plural } from '@/lib/format'
import { toast } from '@/lib/toast'
import { LibraryContext, type LibraryActions, type LibraryTarget, type WantTarget } from './library-context'

/** Sets fields of one entity in every cached answer that shows it. */
function patchCache(client: QueryClient, id: string, patch: Record<string, unknown>) {
  client.setQueriesData({}, data => patchEntity(data, id, patch))
}

const wantedId = (target: WantTarget) => (target.type === 'album' ? target.album.id : target.track.id)
const playlistTracks = (tracks: TrackSummary[]) => tracks.slice(0, 1000).map(track => ({ trackId: track.id, albumId: track.album?.id ?? null }))
const songs = (tracks: TrackSummary[]) => (tracks.length === 1 ? tracks[0].title : plural(tracks.length, 'song'))

/**
 * Likes, wants, the library and playlists against the API. Likes, wants and the library are optimistic: every
 * cached answer that shows the entity changes at once, and goes back if the server says
 * no. The server's invalidations then bring the lists that gained or lost it.
 */
export function LibraryProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const user = useCurrentUser()
  const wantlistEnabled = useWantlistEnabled()
  const wants = useWants(wantlistEnabled).data
  const allPlaylists = usePlaylists().data
  const [draft, setDraft] = useState<{ tracks: TrackSummary[] } | null>(null)

  const like = useMutation({
    mutationFn: ({ type, id, liked }: { type: LikeEntityType; id: string; liked: boolean }) =>
      (liked ? api.userdata.like(type, id) : api.userdata.unlike(type, id)),
    onMutate: ({ id, liked }) => patchCache(queryClient, id, { liked }),
    onError: (_error, { id, liked }) => patchCache(queryClient, id, { liked: !liked }),
  })

  const want = useMutation({
    mutationFn: ({ target, wanted }: { target: WantTarget; wanted: boolean }) =>
      (wanted ? api.userdata.want(target.type, wantedId(target)) : api.userdata.unwant(target.type, wantedId(target))),
    onMutate: ({ target, wanted }) => {
      const id = wantedId(target)
      patchCache(queryClient, id, { wanted })
      const item: WantItem = target.type === 'album'
        ? { type: 'album', album: target.album, wantedAt: new Date().toISOString(), fulfilledAt: null }
        : { type: 'track', track: target.track, wantedAt: new Date().toISOString(), fulfilledAt: null }
      queryClient.setQueryData<Page<WantItem>>(queryKeys.wants(), page => page && {
        ...page,
        items: [...(wanted ? [item] : []), ...page.items.filter(existing => (existing.type === 'album' ? existing.album.id : existing.track.id) !== id)],
      })
    },
    onError: (_error, { target, wanted }) => {
      patchCache(queryClient, wantedId(target), { wanted: !wanted })
      return queryClient.invalidateQueries({ queryKey: queryKeys.wants() })
    },
  })

  // A track carries `inLibrary`, an album page `library`; patching both fields reaches each where it shows.
  const libraryPatch = (inLibrary: boolean) => ({ inLibrary, library: inLibrary ? 'saved' : null })
  const save = useMutation({
    mutationFn: ({ target, inLibrary }: { target: LibraryTarget; inLibrary: boolean }) =>
      (inLibrary ? api.library.save(target.type, target.id) : api.library.remove(target.type, target.id)),
    onMutate: ({ target, inLibrary }) => {
      patchCache(queryClient, target.id, libraryPatch(inLibrary))
      toast({ title: inLibrary ? 'Added to your library' : 'Removed from your library', description: target.title })
    },
    onError: (_error, { target, inLibrary }) => patchCache(queryClient, target.id, libraryPatch(!inLibrary)),
    // The library's lists and Home's "Recently added" gain or lose it.
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.library() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.home() }),
    ]),
  })

  const add = useMutation({
    mutationFn: ({ playlist, tracks }: { playlist: Pick<PlaylistSummary, 'id' | 'name'>; tracks: TrackSummary[] }) =>
      api.userdata.addPlaylistItems(playlist.id, { tracks: playlistTracks(tracks) }),
    onSuccess: (detail, { playlist, tracks }) => {
      queryClient.setQueryData(queryKeys.playlist(detail.id), detail)
      toast({ title: `Added to ${playlist.name}`, description: songs(tracks) })
    },
  })

  const create = useMutation({
    mutationFn: async ({ request, tracks }: { request: CreatePlaylistRequest; tracks: TrackSummary[] }) => {
      const playlist = await api.userdata.createPlaylist(request)
      if (tracks.length) await api.userdata.addPlaylistItems(playlist.id, { tracks: playlistTracks(tracks) })
      return playlist
    },
    onSuccess: async (playlist, { tracks }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.playlists() })
      if (tracks.length) toast({ title: `Added to ${playlist.name}`, description: songs(tracks) })
      else void navigate(`/playlist/${playlist.id}`)
    },
    meta: { inline: true },
  })

  const wantedIds = useMemo(() => new Set(wants?.items.map(item => (item.type === 'album' ? item.album.id : item.track.id))), [wants])
  const playlists = useMemo(() => allPlaylists?.items.filter(playlist => playlist.ownerId === user.id) ?? [], [allPlaylists, user.id])
  const { mutate: setLiked } = like
  const { mutate: setWanted } = want
  const { mutate: setSaved } = save
  const { mutate: addTo } = add

  const actions = useMemo<LibraryActions>(() => ({
    wantlistEnabled,
    isWanted: (id, fromServer = false) => fromServer || wantedIds.has(id),
    setLiked: (type, id, liked) => setLiked({ type, id, liked }),
    setWanted: (target, wanted) => setWanted({ target, wanted }),
    setInLibrary: (target, inLibrary) => setSaved({ target, inLibrary }),
    playlists,
    addToPlaylist: (playlist, tracks) => { if (tracks.length) addTo({ playlist, tracks }) },
    newPlaylist: (tracks = []) => setDraft({ tracks }),
  }), [wantlistEnabled, wantedIds, playlists, setLiked, setWanted, setSaved, addTo])

  return (
    <LibraryContext value={actions}>
      {children}
      <PlaylistDialog
        open={draft !== null}
        onOpenChange={open => { if (!open) setDraft(null) }}
        description={draft?.tracks.length ? `It starts with ${songs(draft.tracks)}.` : undefined}
        onSubmit={request => create.mutateAsync({ request, tracks: draft?.tracks ?? [] })}
      />
    </LibraryContext>
  )
}
