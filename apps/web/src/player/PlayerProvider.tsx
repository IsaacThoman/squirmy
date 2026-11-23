import {
  PlaybackNoticeWatcher, planChanges, randomSeed, refreshFetchedTracks, SessionClient, skipNotice, TrackStore, unavailableNotice, type ApiClient, type PlaybackNotice, type SessionClientSnapshot,
} from '@squirmy/client-core'
import { createSocketTransport, type SquirmySocket } from '@squirmy/client-core/socket'
import { queryKeys, type ClientDevice, type EntityChanges, type QueueEntry, type QueueSeed, type SessionCommand, type StreamQuality, type TrackSummary } from '@squirmy/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { use, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useUserSettings } from '@/api/queries'
import { useApi } from '@/api/services'
import { useCurrentUser } from '@/auth/session'
import { apiArtUrl } from '@/lib/artwork'
import { isPlayable } from '@/lib/catalog'
import { playableCodecs } from '@/lib/codecs'
import { browserName, claimTabDevice, saveBrowserName } from '@/lib/device'
import { useDocumentTitle } from '@/lib/document-title'
import { toast } from '@/lib/toast'
import { useRealtime } from '@/realtime/realtime-context'
import { useEngine } from './engine/engine-context'
import { AUDIO_BLOCKED_MESSAGE } from './engine/errors'
import type { WebPlayerEngine } from './engine/web-engine'
import { MediaSessionAdapter, mediaArtwork, type MediaSessionTrack } from './engine/media-session'
import { Listening, type Audible } from './listening'
import { PlayerContext, PlayerControlsContext, PositionClock, PositionContext, type PlayerControls, type PlayerState, type QueueItem, type RadioSeed } from './player-context'
import { useShortcuts } from './shortcuts'

/** The most tracks one `playTracks` or `enqueue` may carry. */
const MAX_SEEDS = 5000
/** How long Clear history can be undone before the session forgets the history. */
const HISTORY_UNDO_MS = 5000


/**
 * The session client of this tab. Playback is resolved with the user's streaming quality,
 * which `setQuality` keeps current, and the codecs this browser plays.
 */
function createSession(api: ApiClient, socket: SquirmySocket, device: ClientDevice, engine: WebPlayerEngine, store: TrackStore) {
  let quality: StreamQuality = 'original'
  const client = new SessionClient({
    transport: createSocketTransport(socket),
    device,
    onDetachedEnded: reason => toast({
      title: 'Playing with your other devices again',
      description: reason === 'expired' ? 'This tab was away for over a week, so its own queue was cleared.' : 'Its own queue had already been cleared.',
    }),
    player: {
      engine,
      baseUrl: '',
      canBoost: engine.canBoost,
      resolvePlayback: entry => api.streaming.playback(entry.trackId, { albumId: entry.albumId ?? undefined, quality, codecs: playableCodecs().join(',') }),
      // A failure that may pass is retried by the client. A track the server refused to stream
      // (gone, or not allowed) is told once and skipped, as one the browser cannot play.
      onLoadError: (entry, _error, willRetry) => {
        if (willRetry || client.getSnapshot().session.current?.id !== entry.id) return
        const title = store.get(entry.trackId, entry.albumId)?.title
        toast({ title: title ? `Couldn’t play “${title}”` : 'Couldn’t play this song', description: 'Skipped.' })
        client.dispatch({ type: 'next' })
      },
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
  const viewer = useCurrentUser()
  // The page's own engine; the dev page's instrumented replacement is not the session's.
  const [engine] = useState(() => {
    if (!pageEngine || !socket) throw new Error('PlayerProvider needs an engine and the realtime socket')
    return pageEngine
  })
  const [store] = useState(() => new TrackStore(request => api.catalog.trackSummaries(request)))
  const [{ client, setQuality }] = useState(() => createSession(api, socket!, tab.device, engine, store))
  const [listening] = useState(() => new Listening(client, engine))
  const [clock] = useState(() => new PositionClock(() => listening.position()))
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot)
  // What can be heard follows the engine as well as the session: the session says playing long before the first sample.
  const subscribeAudible = useCallback((listener: () => void) => {
    const unsubscribe = [client.subscribe(listener), engine.subscribe(listener)]
    return () => unsubscribe.forEach(undo => undo())
  }, [client, engine])
  const audible = useSyncExternalStore(subscribeAudible, () => listening.audible())
  const [, summariesArrived] = useReducer((count: number) => count + 1, 0)
  // History cleared but still undoable: hidden here, and only forgotten once the time is up.
  const [clearedHistory, setClearedHistory] = useState<ReadonlySet<string> | null>(null)
  const historyClear = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(historyClear.current), [])

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
    listening.update()
    clock.sync()
    // The clock runs only while there is sound, so it never counts through silence.
    clock.setRunning(audible === 'playing')
  }, [listening, clock, session, audible])
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
    const playable = (track: TrackSummary) => isPlayable(track, viewer)
    return {
      togglePlay: () => {
        // The player shows Play while the browser holds the audio back, so pressing it plays.
        if (engine.isBlocked()) return engine.unlock()
        dispatch({ type: latest().session.playing ? 'pause' : 'play' })
      },
      next: () => dispatch({ type: 'next' }),
      previous: () => dispatch({ type: 'previous' }),
      seek: positionMs => {
        listening.seek(Math.max(0, Math.round(positionMs)))
        clock.sync()
      },
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
      clearHistory: () => {
        const { history } = latest().queue
        if (!history.length) return
        clearTimeout(historyClear.current)
        setClearedHistory(new Set(history.map(entry => entry.id)))
        historyClear.current = setTimeout(() => {
          dispatch({ type: 'clearHistory' })
          setClearedHistory(null)
        }, HISTORY_UNDO_MS)
        toast({
          title: 'History cleared',
          action: {
            label: 'Undo',
            onClick: () => {
              clearTimeout(historyClear.current)
              setClearedHistory(null)
            },
          },
        })
      },
      transfer: deviceId => dispatch({ type: 'transfer', deviceId }),
      prepareHere: () => client.prepareTakeover(),
      detach: () => client.detach(),
      attach: options => client.attach(options),
      renameDevice: name => {
        saveBrowserName(name)
        client.rename(browserName())
      },
    }
  }, [client, engine, listening, clock, store, tab, startRadio, viewer])

  usePlaybackNotices(client, store)
  useFreshSummaries(client, store, socket!)
  useEngineErrors(engine, client, store)
  useMediaSession(client, engine, controls, snapshot, audible, clock, track ?? null)
  useShortcuts(controls, clock, snapshot, tab.device.id)

  useDocumentTitle(track ?? null, session.playing && audible !== 'blocked')

  // Rebuilt on every render: summaries arriving re-render this provider, and nothing else does much.
  const thisDeviceId = tab.device.id
  const state: PlayerState = {
    current: current && track ? { entry: current, track } : null,
    playing: session.playing && audible !== 'blocked',
    waiting: audible === 'waiting',
    blocked: audible === 'blocked',
    volume: session.volumes[session.activeDeviceId ?? thisDeviceId] ?? 1,
    volumes: session.volumes,
    shuffle: session.shuffle,
    repeat: session.repeat,
    autoplay: session.autoplay,
    context: session.context,
    queue: hydrate(store, queue.queue),
    history: hydrate(store, clearedHistory ? queue.history.filter(entry => !clearedHistory.has(entry.id)) : queue.history),
    autoplayQueue: hydrate(store, queue.autoplayQueue),
    devices: [...snapshot.devices],
    thisDeviceId,
    activeDeviceId: session.activeDeviceId,
    away: snapshot.away,
    lyrics: lyrics.data ?? null,
    // "No lyrics" only once the server said so: before the answer, or after a failure, they may
    // exist. A retry after a failure shows as loading again.
    lyricsStatus: !track?.hasLyrics ? 'none' : lyrics.data ? 'ready' : lyrics.error && !lyrics.isFetching ? 'failed' : 'loading',
    retryLyrics: () => void lyrics.refetch(),
    detached: snapshot.detached,
    canDetach: snapshot.canDetach,
  }

  return (
    <PlayerControlsContext value={controls}>
      <PlayerContext value={{ state, controls }}>
        <PositionContext value={clock}>{children}</PositionContext>
      </PlayerContext>
    </PlayerControlsContext>
  )
}

const RUN_TOAST = 'playback-unavailable'
/**
 * How long a skipped song's notice waits. When the provider is down the server fails the
 * current and next songs in one moment and then stops, and the stop's one notice says it
 * all: the songs' own notices are dropped if it comes within this time.
 */
const STOP_GRACE_MS = 1500

/**
 * Says when music could not be had, worded as on every client (client-core's
 * `PlaybackNoticeWatcher`): one notice per song that was playing or next and was skipped,
 * one notice that counts a run of songs the provider does not have, and one when playback stops on a
 * failure instead (an outage, failures in a row, or nothing left that is available), with
 * no more per song until playback resumes. A skipped song is told a moment late, so the songs
 * an outage fails just before it stops are not told beside the stop. Failures further down the queue and fetches for
 * the library are quiet: their rows simply turn gray.
 */
function usePlaybackNotices(client: SessionClient, store: TrackStore) {
  useEffect(() => {
    const watcher = new PlaybackNoticeWatcher(trackId => client.failureOf(trackId))
    const tell = ({ message, detail }: PlaybackNotice, key?: string) => toast({ key, title: message, description: detail })
    const held = new Set<ReturnType<typeof setTimeout>>()
    const look = () => {
      const { skipped, unavailable, stopped } = watcher.update(client.getSnapshot())
      for (const { entry, failure } of skipped) {
        const notice = skipNotice(store.get(entry.trackId, entry.albumId)?.title, failure)
        const timer = setTimeout(() => {
          held.delete(timer)
          tell(notice)
        }, STOP_GRACE_MS)
        held.add(timer)
      }
      // One notice for a run of songs not to be had, and for the stop that may end it.
      if (unavailable) tell(unavailableNotice(unavailable, store.get(unavailable.entry.trackId, unavailable.entry.albumId)?.title), RUN_TOAST)
      if (stopped) {
        for (const timer of held) clearTimeout(timer)
        held.clear()
        tell(stopped, RUN_TOAST)
      }
    }
    look()
    const unsubscribe = client.subscribe(look)
    return () => {
      unsubscribe()
      for (const timer of held) clearTimeout(timer)
    }
  }, [client, store])
}

/**
 * Keeps tracks' summaries current: a song it just fetched is read again (its album and cover
 * come with the file), as is any track an invalidation names, and the values the server's
 * `changes` carry (availability, so a song that could not be had turns gray in the queue too;
 * hearts and library membership) are set on the stored summaries without a request. The
 * queue, the player and the system's media controls all show the store's summaries.
 */
function useFreshSummaries(client: SessionClient, store: TrackStore, socket: SquirmySocket) {
  useEffect(() => refreshFetchedTracks(client, store), [client, store])
  useEffect(() => {
    const refresh = ({ keys }: { keys: readonly (readonly unknown[])[] }) => store.refreshInvalidated(keys)
    const patch = ({ changes }: EntityChanges) => store.patch(planChanges(changes).patches)
    socket.on('invalidate', refresh)
    socket.on('changes', patch)
    return () => {
      socket.off('invalidate', refresh)
      socket.off('changes', patch)
    }
  }, [socket, store])
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
function useMediaSession(client: SessionClient, engine: WebPlayerEngine, controls: PlayerControls, snapshot: SessionClientSnapshot, audible: Audible, clock: PositionClock, track: TrackSummary | null) {
  const adapter = useRef<MediaSessionAdapter | null>(null)
  useEffect(() => {
    const created = new MediaSessionAdapter({
      // A media key is a gesture too, so it can start audio the browser held back.
      play: () => (engine.isBlocked() ? engine.unlock() : client.dispatch({ type: 'play' })),
      pause: () => client.dispatch({ type: 'pause' }),
      next: controls.next,
      previous: controls.previous,
      seek: controls.seek,
    })
    adapter.current = created
    return () => created.dispose()
  }, [client, engine, controls])

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
      // The system's clock runs on its own while it is told playing, so only sound counts.
      playing: audible === 'playing',
      positionMs: clock.get(),
      durationMs: session.current?.durationMs ?? 0,
    })
  }, [clock, metadata, session, audible])
}
