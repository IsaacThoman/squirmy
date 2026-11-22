import { randomSeed, SessionClient, TrackStore, type ApiClient, type SessionClientSnapshot } from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import { queryKeys, type ClientDevice, type QueueEntry, type QueueSeed, type SessionCommand, type StreamQuality, type TrackSummary } from '@squirmy/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { use, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useUserSettings } from '@/api/queries'
import { useApi } from '@/api/services'
import { useCurrentUser } from '@/auth/session'
import { apiArtUrl } from '@/lib/artwork'
import { canRequestMusic, isPlayable } from '@/lib/catalog'
import { playableCodecs } from '@/lib/codecs'
import { browserName, claimTabDevice, saveBrowserName, tabDeviceName } from '@/lib/device'
import { toast } from '@/lib/toast'
import { useRealtime } from '@/realtime/realtime-context'
import { useEngine } from './engine/engine-context'
import { AUDIO_BLOCKED_MESSAGE } from './engine/errors'
import type { WebPlayerEngine } from './engine/web-engine'
import { MediaSessionAdapter, mediaArtwork, type MediaSessionTrack } from './engine/media-session'
import { PlayerContext, PlayerControlsContext, PositionClock, PositionContext, type PlayerControls, type PlayerState, type QueueItem, type RadioSeed } from './player-context'
import { useShortcuts } from './shortcuts'

/** The most tracks one `playTracks` or `enqueue` may carry. */
const MAX_SEEDS = 5000


/**
 * The session client of this tab. Playback is resolved with the user's streaming quality,
 * which `setQuality` keeps current, and the codecs this browser plays.
 */
function createSession(api: ApiClient, socket: SquirmySocket, device: ClientDevice, engine: WebPlayerEngine) {
  let quality: StreamQuality = 'original'
  const client = new SessionClient({
    transport: createSocketTransport(socket),
    device,
    player: {
      engine,
      baseUrl: '',
      canBoost: engine.canBoost,
      resolvePlayback: entry => api.streaming.playback(entry.trackId, { albumId: entry.albumId ?? undefined, quality, codecs: playableCodecs().join(',') }),
    },
  })
  return { client, setQuality: (next: StreamQuality) => { quality = next } }
}

function hydrate(store: TrackStore, entries: readonly QueueEntry[]): QueueItem[] {
  return entries.flatMap(entry => {
    const track = store.get(entry.trackId, entry.albumId)
    return track ? [{ entry, track }] : []
  })
}

/** What the session needs of a track. The server looks up the rest and drops what cannot play. */
function seedOf(track: TrackSummary): QueueSeed {
  return { trackId: track.id, albumId: track.album?.id ?? null, durationMs: track.durationMs, state: track.availability === 'on_demand' ? 'preparing' : 'ready' }
}

/**
 * The player of the signed-in app: one `SessionClient` on the user's socket, driving the
 * page's audio engine while this tab is the active device and following the session
 * otherwise. It hydrates entries through a `TrackStore`, resolves playback with the
 * user's quality and this browser's codecs, mirrors the session on the system's media
 * controls and the tab title, and answers the keyboard.
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const api = useApi()
  const { socket } = useRealtime()
  const pageEngine = useEngine()
  const tab = use(claimTabDevice())
  const settings = useUserSettings().data
  const canRequest = canRequestMusic(useCurrentUser())
  // The page's own engine; the dev page's instrumented replacement is not the session's.
  const [engine] = useState(() => {
    if (!pageEngine || !socket) throw new Error('PlayerProvider needs an engine and the realtime socket')
    return pageEngine
  })
  const [{ client, setQuality }] = useState(() => createSession(api, socket!, tab.device, engine))
  const [store] = useState(() => new TrackStore(request => api.catalog.trackSummaries(request)))
  const [clock] = useState(() => new PositionClock(() => client.getPositionMs()))
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot)
  const [, summariesArrived] = useReducer((count: number) => count + 1, 0)

  useEffect(() => {
    client.start()
    return () => client.dispose()
  }, [client])
  useEffect(() => store.subscribe(summariesArrived), [store])

  useEffect(() => {
    if (!settings) return
    setQuality(settings.qualityWifi)
    client.setNormalization(settings.normalization)
  }, [client, setQuality, settings])

  const { session, queue } = snapshot
  useEffect(() => {
    clock.sync()
    clock.setRunning(session.playing && !session.stalled && session.current?.state === 'ready')
  }, [clock, session])
  useEffect(() => engine.subscribe(() => clock.sync()), [engine, clock])
  useEffect(() => () => clock.setRunning(false), [clock])

  const current = session.current
  const stored = current ? store.get(current.trackId, current.albumId) : undefined
  // The current track's own query, so its heart follows likes from anywhere.
  const fresh = useQuery({
    queryKey: [...queryKeys.track(current?.trackId ?? ''), current?.albumId ?? null],
    queryFn: () => api.catalog.track(current!.trackId, { albumId: current!.albumId ?? undefined }),
    enabled: Boolean(current),
    meta: { silent: true },
  })
  const track = current && (fresh.data?.id === current.trackId ? fresh.data : stored)
  const lyrics = useQuery({
    queryKey: queryKeys.lyrics(track?.id ?? ''),
    queryFn: () => api.catalog.lyrics(track!.id),
    enabled: Boolean(track?.hasLyrics),
    staleTime: Infinity,
    meta: { silent: true },
  })


  const radio = useMutation({
    mutationFn: (seed: RadioSeed) => (seed.type === 'track' ? api.radio.track(seed.id) : api.radio.artist(seed.id)),
    onSuccess: ({ tracks, context }) => client.dispatch({ type: 'playTracks', tracks, startIndex: 0, shuffle: false, seed: randomSeed(), context }),
  })
  const startRadio = radio.mutate

  const controls = useMemo<PlayerControls>(() => {
    const dispatch = (command: SessionCommand) => client.dispatch(command)
    const latest = () => client.getSnapshot()
    const shown = (entries: readonly QueueEntry[]) => entries.filter(entry => store.get(entry.trackId, entry.albumId))
    const playable = (track: TrackSummary) => isPlayable(track, canRequest)
    return {
      togglePlay: () => dispatch({ type: latest().session.playing ? 'pause' : 'play' }),
      next: () => dispatch({ type: 'next' }),
      previous: () => dispatch({ type: 'previous' }),
      seek: positionMs => dispatch({ type: 'seek', positionMs: Math.max(0, Math.round(positionMs)) }),
      setVolume: (volume, deviceId = latest().session.activeDeviceId ?? tab.device.id) =>
        dispatch({ type: 'setVolume', deviceId, value: Math.min(1, Math.max(0, volume)) }),
      setShuffle: value => dispatch({ type: 'setShuffle', value, seed: randomSeed() }),
      cycleRepeat: () => {
        const { repeat } = latest().session
        dispatch({ type: 'setRepeat', value: repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off' })
      },
      setAutoplay: value => dispatch({ type: 'setAutoplay', value }),
      playTracks: (tracks, startIndex = 0, context, options = {}) => {
        const candidates = tracks.flatMap((track, index) => (playable(track) ? [{ track, index }] : []))
        if (!candidates.length) return
        store.prime(tracks)
        // The requested track, or the first playable one after it.
        const start = Math.max(0, candidates.findIndex(candidate => candidate.index >= startIndex))
        const fits = candidates.length <= MAX_SEEDS
        const sent = options.shuffle || fits ? candidates.slice(0, MAX_SEEDS) : candidates.slice(start, start + MAX_SEEDS)
        dispatch({
          type: 'playTracks',
          tracks: sent.map(candidate => seedOf(candidate.track)),
          startIndex: options.shuffle ? undefined : fits ? start : 0,
          shuffle: options.shuffle || undefined,
          seed: randomSeed(),
          context: context ?? null,
        })
      },
      enqueue: (tracks, placement) => {
        const seeds = tracks.filter(playable).slice(0, MAX_SEEDS).map(seedOf)
        if (!seeds.length) return
        store.prime(tracks)
        dispatch({ type: 'enqueue', tracks: seeds, placement })
      },
      startRadio,
      playEntry: entryId => {
        const { queue: lists } = latest()
        const past = lists.history.find(entry => entry.id === entryId)
        if (!past) return dispatch({ type: 'playQueueEntry', entryId })
        // History is not playable in place: queue the track again and play that entry.
        dispatch({ type: 'enqueue', tracks: [{ trackId: past.trackId, albumId: past.albumId, durationMs: past.durationMs }], placement: 'next' })
        const added = latest().queue.queue[0]
        if (added) dispatch({ type: 'playQueueEntry', entryId: added.id })
      },
      removeEntry: entryId => dispatch({ type: 'removeFromQueue', entryId }),
      moveEntry: (entryId, toIndex) => {
        const { queue: lists } = latest()
        const list = lists.queue.some(entry => entry.id === entryId) ? lists.queue : lists.autoplayQueue
        const target = shown(list)[toIndex]
        if (target) dispatch({ type: 'moveInQueue', entryId, toIndex: list.indexOf(target) })
      },
      clearQueue: () => dispatch({ type: 'clearQueue' }),
      clearHistory: () => dispatch({ type: 'clearHistory' }),
      transfer: deviceId => dispatch({ type: 'transfer', deviceId }),
      renameDevice: name => {
        saveBrowserName(name)
        client.rename(tabDeviceName(browserName(), tab.slot))
      },
    }
  }, [client, store, tab, startRadio, canRequest])

  useEntryFailures(snapshot, store)
  useEngineErrors(engine, client, store)
  useMediaSession(client, controls, snapshot, track ?? null)
  useShortcuts(controls, clock, snapshot, tab.device.id)

  useEffect(() => {
    document.title = track ? `${track.title} · ${track.artistCredit}` : 'Squirmy'
  }, [track])

  // Rebuilt on every render: summaries arriving re-render this provider, and nothing else does much.
  const thisDeviceId = tab.device.id
  const state: PlayerState = {
    current: current && track ? { entry: current, track } : null,
    playing: session.playing,
    volume: session.volumes[session.activeDeviceId ?? thisDeviceId] ?? 1,
    volumes: session.volumes,
    shuffle: session.shuffle,
    repeat: session.repeat,
    autoplay: session.autoplay,
    context: session.context,
    queue: hydrate(store, queue.queue),
    history: hydrate(store, queue.history),
    autoplayQueue: hydrate(store, queue.autoplayQueue),
    devices: [...snapshot.devices],
    thisDeviceId,
    activeDeviceId: session.activeDeviceId,
    lyrics: lyrics.data ?? null,
  }

  return (
    <PlayerControlsContext value={controls}>
      <PlayerContext value={{ state, controls }}>
        <PositionContext value={clock}>{children}</PositionContext>
      </PlayerContext>
    </PlayerControlsContext>
  )
}

/** An on-demand track that could not be fetched is skipped by the session; say so. */
function useEntryFailures(snapshot: SessionClientSnapshot, store: TrackStore) {
  const known = useRef(new Map<string, QueueEntry['state']>())
  useEffect(() => {
    const { session, queue } = snapshot
    const entries = [...(session.current ? [session.current] : []), ...queue.queue, ...queue.autoplayQueue, ...queue.history]
    const states = new Map(entries.map(entry => [entry.id, entry.state]))
    for (const entry of entries) {
      const before = known.current.get(entry.id)
      if (entry.state === 'failed' && before && before !== 'failed') {
        const title = store.get(entry.trackId, entry.albumId)?.title
        toast({ title: title ? `Couldn’t get “${title}”` : 'Couldn’t get a song', description: 'It was skipped.' })
      }
    }
    known.current = states
  }, [snapshot, store])
}

/** A track the browser cannot play (gone, or a format it refuses) is reported and skipped. */
function useEngineErrors(engine: WebPlayerEngine, client: SessionClient, store: TrackStore) {
  useEffect(() => engine.subscribe(event => {
    if (event.type !== 'error' || event.message === AUDIO_BLOCKED_MESSAGE) return
    const { session, isActiveDevice, connection } = client.getSnapshot()
    if (!isActiveDevice || connection !== 'online' || session.current?.id !== event.entryId) return
    const title = store.get(session.current.trackId, session.current.albumId)?.title
    toast({ title: title ? `Couldn’t play “${title}”` : 'Couldn’t play this song', description: event.message })
    client.dispatch({ type: 'next' })
  }), [engine, client, store])
}

/** The system's media controls show what this tab plays, and drive the session. */
function useMediaSession(client: SessionClient, controls: PlayerControls, snapshot: SessionClientSnapshot, track: TrackSummary | null) {
  const adapter = useRef<MediaSessionAdapter | null>(null)
  useEffect(() => {
    const created = new MediaSessionAdapter({
      play: () => client.dispatch({ type: 'play' }),
      pause: () => client.dispatch({ type: 'pause' }),
      next: controls.next,
      previous: controls.previous,
      seek: controls.seek,
    })
    adapter.current = created
    return () => created.dispose()
  }, [client, controls])

  const shown = snapshot.isActiveDevice ? track : null
  const metadata = useMemo<MediaSessionTrack | null>(() => {
    if (!shown) return null
    const artwork = shown.album?.artwork
    return {
      title: shown.title,
      artist: shown.artistCredit,
      album: shown.album?.title ?? '',
      artwork: artwork ? mediaArtwork(size => new URL(apiArtUrl(artwork, size), window.location.origin).href) : [],
    }
  }, [shown])

  const { session } = snapshot
  useEffect(() => {
    adapter.current?.update({
      track: metadata,
      playing: session.playing && !session.stalled,
      positionMs: client.getPositionMs(),
      durationMs: session.current?.durationMs ?? 0,
    })
  }, [client, metadata, session])
}
