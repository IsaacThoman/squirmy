import { queryKeys, type CreatePlaylistRequest, type EntityFields, type Page, type PlaylistSummary, type TrackSummary, type WantItem } from '@squirmy/contracts'
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { applyChanges } from '@/realtime/apply-changes'
import { failedStep } from '@/api/errors'
import { patchEntity } from '@/api/patch'
import { playlistQuery, usePlaylists, useWants } from '@/api/queries'
import { useApi } from '@/api/services'
import { useCurrentUser, useWantlistEnabled } from '@/auth/session'
import { AlreadyInPlaylistDialog, type RepeatedAdd } from '@/components/layout/AlreadyInPlaylistDialog'
import { PlaylistDialog } from '@/components/layout/PlaylistDialog'
import { plural } from '@/lib/format'
import { LibraryContext, LibraryFailures, LibraryFailuresContext, type LibraryActions, type LibraryTarget, type WantTarget } from './library-context'

/** Sets fields of one entity in every cached answer that shows it. */
function patchCache(client: QueryClient, id: string, patch: Record<string, unknown>) {
  client.setQueriesData({}, data => patchEntity(data, id, patch))
}

/**
 * Drops reads of the entity already on their way, before it is patched optimistically: an album
 * page re-reads itself while its songs arrive, and an answer sent before the save would land
 * after the patch and put the old heart back until the next refetch. They are cancelled without
 * reverting, so what they held stays and the patch lands on it; the save's changes and
 * invalidations bring the server's answer after.
 */
function dropReadsOf(client: QueryClient, id: string, fields: Record<string, unknown>) {
  void client.cancelQueries({
    predicate: query => query.state.fetchStatus === 'fetching' && patchEntity(query.state.data, id, fields) !== query.state.data,
  }, { revert: false })
}

const wantedId = (target: WantTarget) => (target.type === 'album' ? target.album.id : target.track.id)
const wantedTitle = (target: WantTarget) => (target.type === 'album' ? target.album.title : target.track.title)
const playlistTracks = (tracks: TrackSummary[]) => tracks.slice(0, 1000).map(track => ({ trackId: track.id, albumId: track.album?.id ?? null }))
/** A promise whose rejection nobody has to handle: fire-and-forget callers leave failures to the control. */
const handled = <T,>(promise: Promise<T>): Promise<T> => {
  promise.catch(() => {})
  return promise
}

/** Whether a retried form asks for other details than the try that made the playlist did. */
const otherDetails = (before: CreatePlaylistRequest, request: CreatePlaylistRequest) =>
  request.name !== before.name || (request.description ?? null) !== (before.description ?? null) || (request.isPublic ?? false) !== (before.isPublic ?? false)

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
  const [failures] = useState(() => new LibraryFailures())
  const announced = useSyncExternalStore(failures.subscribe, failures.latest)
  const heart = (target: LibraryTarget, fields: EntityFields) =>
    applyChanges(queryClient, [{ kind: 'patch', entity: target.type, id: target.id, fields }])

  // The heart. A saved track or artist is in the library at once; after a removal only the server
  // knows whether it still is (on the collection, on a saved album). It shows here as the same
  // `patch` change the server then sends every device of the user, with the values it holds, and
  // the lists that gain or lose it (the library's, Liked Songs, Home) follow the server's
  // invalidation, so nothing is fetched twice and no page or search is fetched at all.
  const save = useMutation({
    mutationFn: ({ target, saved }: { target: LibraryTarget; saved: boolean }) =>
      (saved ? api.userdata.like(target.type, target.id) : api.userdata.unlike(target.type, target.id)),
    onMutate: ({ target, saved }) => {
      const fields = saved ? { liked: true, inLibrary: true } : { liked: false }
      dropReadsOf(queryClient, target.id, fields)
      heart(target, fields)
      failures.clear(`save:${target.id}`)
    },
    // The heart goes back and says so beside itself; nothing floats over the page.
    onError: (_error, { target, saved }) => {
      heart(target, { liked: !saved })
      failures.fail(
        `save:${target.id}`,
        saved ? 'Couldn’t save. Try again.' : 'Couldn’t remove. Try again.',
        saved ? `Couldn’t save “${target.title}” to your library. Try again.` : `Couldn’t remove “${target.title}” from your library. Try again.`,
      )
    },
  })

  const want = useMutation({
    mutationFn: ({ target, wanted }: { target: WantTarget; wanted: boolean }) =>
      (wanted ? api.userdata.want(target.type, wantedId(target)) : api.userdata.unwant(target.type, wantedId(target))),
    onMutate: ({ target, wanted }) => {
      const id = wantedId(target)
      failures.clear(`want:${id}`)
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
      failures.fail(
        `want:${wantedId(target)}`,
        wanted ? 'Couldn’t add to your Wantlist. Try again.' : 'Couldn’t remove from your Wantlist. Try again.',
        wanted ? `Couldn’t add “${wantedTitle(target)}” to your Wantlist. Try again.` : `Couldn’t remove “${wantedTitle(target)}” from your Wantlist. Try again.`,
      )
      return queryClient.invalidateQueries({ queryKey: queryKeys.wants() })
    },
  })

  const add = useMutation({
    mutationFn: ({ playlist, tracks, skipDuplicates }: { playlist: Pick<PlaylistSummary, 'id' | 'name'>; tracks: TrackSummary[]; skipDuplicates?: boolean }) =>
      api.userdata.addPlaylistItems(playlist.id, { tracks: playlistTracks(tracks), skipDuplicates }),
    // The place that added them says it did, or that it did not (the menu entry, the sidebar row, the dialog).
    onSuccess: detail => { queryClient.setQueryData(queryKeys.playlist(detail.id), detail) },
  })

  // The playlist the open New playlist dialog has made. When its songs fail to go in, the dialog
  // stays open to try again, and the retry adds them to this one (with any details changed since)
  // rather than making a second, as the iOS app does.
  const made = useRef<{ playlist: PlaylistSummary; request: CreatePlaylistRequest } | null>(null)
  const create = useMutation({
    mutationFn: async ({ request, tracks }: { request: CreatePlaylistRequest; tracks: TrackSummary[] }) => {
      const retry = made.current !== null
      let playlist = made.current?.playlist ?? await api.userdata.createPlaylist(request)
      if (made.current && otherDetails(made.current.request, request)) playlist = await api.userdata.updatePlaylist(playlist.id, request)
      made.current = { playlist, request }
      if (!tracks.length) return playlist
      try {
        // A retry leaves out songs that went in on a try whose answer never came back.
        await api.userdata.addPlaylistItems(playlist.id, { tracks: playlistTracks(tracks), skipDuplicates: retry || undefined })
      } catch (error) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.playlists() })
        throw failedStep(error, `Made “${playlist.name}”, but couldn’t add ${tracks.length === 1 ? `“${tracks[0].title}”` : songs(tracks)}. Try again.`)
      }
      return playlist
    },
    // With songs, the new playlist in the sidebar says it is made; an empty one opens to be filled.
    onSuccess: async (playlist, { tracks }) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.playlists() })
      if (!tracks.length) void navigate(`/playlist/${playlist.id}`)
    },
  })
  const openDraft = useCallback((tracks: TrackSummary[]) => {
    made.current = null
    setDraft({ tracks })
  }, [])

  const wantedIds = useMemo(() => new Set(wants?.items.map(item => (item.type === 'album' ? item.album.id : item.track.id))), [wants])
  const playlists = useMemo(() => allPlaylists?.items.filter(playlist => playlist.ownerId === user.id) ?? [], [allPlaylists, user.id])
  const { mutateAsync: setSaved } = save
  const { mutateAsync: setWanted } = want
  const { mutateAsync: addTo } = add

  // Songs the playlist has already are asked about first. Its cached copy is current enough:
  // the server's invalidations refresh it whenever it changes elsewhere. When what it holds
  // cannot be read, nothing is added: the place that asked says it did not work, to try again,
  // rather than adding songs it may have already without asking.
  const addToPlaylist = useCallback(async (playlist: Pick<PlaylistSummary, 'id' | 'name'>, tracks: TrackSummary[]) => {
    if (!tracks.length) return true
    const detail = await queryClient.fetchQuery({ ...playlistQuery(api, playlist.id), staleTime: 60_000 }).catch((error: unknown) => {
      throw failedStep(error, 'Couldn’t check for songs it has already. Try again.')
    })
    const there = new Set(detail.items.map(item => item.track.id))
    const repeated = tracks.filter(track => there.has(track.id))
    if (repeated.length) {
      setRepeatedAdd({ playlist, tracks, repeated })
      return false
    }
    await addTo({ playlist, tracks })
    return true
  }, [api, queryClient, addTo])

  const actions = useMemo<LibraryActions>(() => ({
    wantlistEnabled,
    isWanted: (id, fromServer = false) => fromServer || wantedIds.has(id),
    setSaved: (target, saved) => handled(setSaved({ target, saved }).then(() => {})),
    setWanted: (target, wanted) => handled(setWanted({ target, wanted }).then(() => {})),
    playlists,
    addToPlaylist: (playlist, tracks) => handled(addToPlaylist(playlist, tracks)),
    newPlaylist: (tracks = []) => openDraft(tracks),
  }), [wantlistEnabled, wantedIds, playlists, setSaved, setWanted, addToPlaylist, openDraft])

  return (
    <LibraryContext value={actions}>
      <LibraryFailuresContext value={failures}>
        {children}
        {/* The heart that was refused says so beside itself; this tells screen readers which item it was. */}
        <p role="status" className="sr-only">{announced}</p>
      </LibraryFailuresContext>
      <AlreadyInPlaylistDialog
        add={repeatedAdd}
        onOpenChange={open => { if (!open) setRepeatedAdd(null) }}
        onAddAnyway={() => addTo({ playlist: repeatedAdd!.playlist, tracks: repeatedAdd!.tracks })}
        onSkip={async () => {
          const fresh = repeatedAdd!.tracks.filter(track => !repeatedAdd!.repeated.includes(track))
          // The server leaves out anything added meanwhile, too.
          if (fresh.length) await addTo({ playlist: repeatedAdd!.playlist, tracks: fresh, skipDuplicates: true })
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
