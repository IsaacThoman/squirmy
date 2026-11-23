import { queryKeys, type CreatePlaylistRequest, type Page, type PlaylistSummary, type TrackSummary, type WantItem } from '@squirmy/contracts'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { patchEntity } from '@/api/patch'
import { playlistQuery, usePlaylists, useWants } from '@/api/queries'
import { useApi } from '@/api/services'
import { useCurrentUser, useWantlistEnabled } from '@/auth/session'
import { AlreadyInPlaylistDialog, type RepeatedAdd } from '@/components/layout/AlreadyInPlaylistDialog'
import { PlaylistDialog } from '@/components/layout/PlaylistDialog'
import { plural } from '@/lib/format'
import { dismissToast, toast } from '@/lib/toast'
import { LibraryContext, type LibraryActions, type LibraryTarget, type WantTarget } from './library-context'

/** Sets fields of one entity in every cached answer that shows it. */
function patchCache(client: QueryClient, id: string, patch: Record<string, unknown>) {
  client.setQueriesData({}, data => patchEntity(data, id, patch))
}

/**
 * Patches the entity optimistically, first dropping reads of it already on their way: an album
 * page re-reads itself while its songs arrive, and an answer sent before the save would land
 * after the patch and put the old heart back until the refetch after the save. They are
 * cancelled without reverting, so what they held stays and the patch lands on it; the
 * invalidation after the save reads them again.
 */
function patchOptimistically(client: QueryClient, id: string, patch: Record<string, unknown>) {
  void client.cancelQueries({
    predicate: query => query.state.fetchStatus === 'fetching' && patchEntity(query.state.data, id, patch) !== query.state.data,
  }, { revert: false })
  patchCache(client, id, patch)
}

const wantedId = (target: WantTarget) => (target.type === 'album' ? target.album.id : target.track.id)
const playlistTracks = (tracks: TrackSummary[]) => tracks.slice(0, 1000).map(track => ({ trackId: track.id, albumId: track.album?.id ?? null }))
/** A promise and the function that settles it. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

type SaveVariables = {
  target: LibraryTarget
  saved: boolean
  undoing?: boolean
  quiet?: boolean
  /** On a save that undoes a removal: when the removed save was made, so it keeps its place. */
  savedAt?: string
  /** On a removal: settles with when the removed save was made, or null if the server refused. */
  removal?: ReturnType<typeof deferred<{ savedAt?: string } | null>>
}

const removalOf = (saved: boolean) => (saved ? undefined : deferred<{ savedAt?: string } | null>())

const songs = (tracks: TrackSummary[]) => (tracks.length === 1 ? tracks[0].title : plural(tracks.length, 'song'))

/**
 * The library (the heart), wants and playlists against the API. Saves and wants are optimistic:
 * every cached answer that shows the entity changes at once, and goes back if the server says
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
  const [repeatedAdd, setRepeatedAdd] = useState<RepeatedAdd | null>(null)

  // The heart. A saved track or artist is in the library at once; after a removal only the server
  // knows whether it still is (on the collection, on a saved album), so the lists ask it.
  const save = useMutation({
    mutationFn: async ({ target, saved, savedAt, removal }: SaveVariables) => {
      if (saved) {
        await (savedAt ? api.userdata.like(target.type, target.id, { savedAt }) : api.userdata.like(target.type, target.id))
        return
      }
      const answer = await api.userdata.unlike(target.type, target.id)
      removal?.resolve({ savedAt: answer.savedAt ?? undefined })
    },
    onMutate: ({ target, saved, undoing, quiet, removal }) => {
      patchOptimistically(queryClient, target.id, saved ? { liked: true, inLibrary: true } : { liked: false })
      // Undo puts it back as it was, quietly: the toast that offered it already said what happened.
      if (undoing || quiet) return {}
      // Undo of a removal waits for the removal's answer, which says when the save was made, so the
      // item goes back to its place in Recently added and Liked Songs rather than to the top. A
      // removal the server refused has nothing to undo.
      const undo = async () => {
        const removed = removal ? await removal.promise : {}
        if (removed) save.mutate({ target, saved: !saved, undoing: true, savedAt: removed.savedAt })
      }
      const toastId = toast({
        title: saved ? 'Saved to your library' : 'Removed from your library',
        description: target.title,
        action: { label: 'Undo', onClick: () => void undo() },
      })
      return { toastId }
    },
    // The success toast said it happened; it goes, and a notice that it did not takes its place.
    onError: (_error, variables, context) => {
      const { target, saved } = variables
      patchCache(queryClient, target.id, { liked: !saved })
      variables.removal?.resolve(null)
      if (context?.toastId !== undefined) dismissToast(context.toastId)
      toast({
        title: saved ? 'Couldn’t save to your library' : 'Couldn’t remove from your library',
        description: target.title,
        action: { label: 'Try again', onClick: () => save.mutate({ ...variables, removal: removalOf(saved) }) },
      })
    },
    // The library's lists, Liked Songs and Home's "Recently added" gain or lose it.
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.library() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.likes() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.home() }),
    ]),
    // The notice above says what failed, with Try again; the cache's own toast would repeat it.
    meta: { inline: true },
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

  const add = useMutation({
    mutationFn: ({ playlist, tracks, skipDuplicates }: { playlist: Pick<PlaylistSummary, 'id' | 'name'>; tracks: TrackSummary[]; skipDuplicates?: boolean }) =>
      api.userdata.addPlaylistItems(playlist.id, { tracks: playlistTracks(tracks), skipDuplicates }),
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
  const { mutate: setSaved } = save
  const { mutate: setWanted } = want
  const { mutate: addTo } = add

  // Songs the playlist has already are asked about first. Its cached copy is current enough:
  // the server's invalidations refresh it whenever it changes elsewhere.
  const addToPlaylist = useCallback(async (playlist: Pick<PlaylistSummary, 'id' | 'name'>, tracks: TrackSummary[]) => {
    if (!tracks.length) return
    const detail = await queryClient.fetchQuery({ ...playlistQuery(api, playlist.id), staleTime: 60_000 }).catch(() => null)
    const there = new Set(detail?.items.map(item => item.track.id))
    const repeated = tracks.filter(track => there.has(track.id))
    if (repeated.length) setRepeatedAdd({ playlist, tracks, repeated })
    else addTo({ playlist, tracks })
  }, [api, queryClient, addTo])

  const actions = useMemo<LibraryActions>(() => ({
    wantlistEnabled,
    isWanted: (id, fromServer = false) => fromServer || wantedIds.has(id),
    setSaved: (target, saved, options) => setSaved({ target, saved, quiet: options?.quiet, removal: removalOf(saved) }),
    setWanted: (target, wanted) => setWanted({ target, wanted }),
    playlists,
    addToPlaylist: (playlist, tracks) => void addToPlaylist(playlist, tracks),
    newPlaylist: (tracks = []) => setDraft({ tracks }),
  }), [wantlistEnabled, wantedIds, playlists, setSaved, setWanted, addToPlaylist])

  return (
    <LibraryContext value={actions}>
      {children}
      <AlreadyInPlaylistDialog
        add={repeatedAdd}
        onOpenChange={open => { if (!open) setRepeatedAdd(null) }}
        onAddAnyway={() => {
          if (repeatedAdd) addTo({ playlist: repeatedAdd.playlist, tracks: repeatedAdd.tracks })
          setRepeatedAdd(null)
        }}
        onSkip={() => {
          const fresh = repeatedAdd?.tracks.filter(track => !repeatedAdd.repeated.includes(track)) ?? []
          // The server leaves out anything added meanwhile, too.
          if (repeatedAdd && fresh.length) addTo({ playlist: repeatedAdd.playlist, tracks: fresh, skipDuplicates: true })
          setRepeatedAdd(null)
        }}
      />
      <PlaylistDialog
        open={draft !== null}
        onOpenChange={open => { if (!open) setDraft(null) }}
        description={draft?.tracks.length ? `It starts with ${songs(draft.tracks)}.` : undefined}
        onSubmit={request => create.mutateAsync({ request, tracks: draft?.tracks ?? [] })}
      />
    </LibraryContext>
  )
}
