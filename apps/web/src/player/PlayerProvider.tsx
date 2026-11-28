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
import { useRealtime } from '@/realtime/realtime-context'
import { useEngine } from './engine/engine-context'
import { AUDIO_BLOCKED_MESSAGE } from './engine/errors'
import type { WebPlayerEngine } from './engine/web-engine'
import { MediaSessionAdapter, mediaArtwork, type MediaSessionTrack } from './engine/media-session'
import { Listening, type Audible } from './listening'
import { NowPlayingContext, PlayerContext, PlayerControlsContext, PositionClock, PositionContext, RadioPendingContext, useNowPlayingStore, type PlayerControls, type PlayerState, type QueueItem, type RadioSeed } from './player-context'
import { useShortcuts } from './shortcuts'
import { STATUS_ERROR_MS, STATUS_EVENT_MS, STATUS_UNDO_MS, StatusLine, type PlayerStatus } from './status'

/** The most tracks one `playTracks` or `enqueue` may carry. */
const MAX_SEEDS = 5000


/** The entry the listener started by name (a song clicked in a list or the queue), while it is current. */
class Picked {
  private entryId: string | null = null
  set(entryId: string | null): void { this.entryId = entryId }
  is(entryId: string): boolean { return this.entryId === entryId }
}

/** "Couldn't play …", for a song that will not play here. */
function couldNotPlay(title: string | undefined, detail?: string): PlaybackNotice {
  return { message: title ? `Couldn’t play “${title}”` : 'Couldn’t play this song', ...(detail && { detail }) }
}

/**
 * What happens when this tab cannot play the current song: the song the listener just picked
 * stays, paused, and the player says why (pressing Play tries again); any other is skipped,
 * as continuous playback goes on.
 */
function failCurrent(client: SessionClient, status: StatusLine, picked: Picked, entryId: string, title: string | undefined, why?: string) {
  if (picked.is(entryId)) {
    status.show({ ...couldNotPlay(title, why), tone: 'error', key: STOP_STATUS })
    client.dispatch({ type: 'pause' })
    return
  }
  status.show({ ...couldNotPlay(title, why ? `${why} Skipped.` : 'Skipped.'), tone: 'info', key: NOTICE_STATUS }, STATUS_EVENT_MS)
  client.dispatch({ type: 'next' })
}

/**
 * The session client of this tab. Playback is resolved with the user's streaming quality,
 * which `setQuality` keeps current, and the codecs this browser plays.
 */
function createSession(api: ApiClient, socket: SquirmySocket, device: ClientDevice, engine: WebPlayerEngine, store: TrackStore, status: StatusLine, picked: Picked) {
  let quality: StreamQuality = 'original'
  const client = new SessionClient({
    transport: createSocketTransport(socket),
    device,
    onDetachedEnded: reason => status.show({
      message: 'Playing with your other devices again',
      detail: reason === 'expired' ? 'This tab was away for over a week, so its own queue was cleared.' : 'Its own queue had already been cleared.',
      tone: 'info',
      key: NOTICE_STATUS,
    }, STATUS_ERROR_MS),
    player: {
      engine,
      baseUrl: '',
      canBoost: engine.canBoost,
      resolvePlayback: entry => api.streaming.playback(entry.trackId, { albumId: entry.albumId ?? undefined, quality, codecs: playableCodecs().join(',') }),
      // A failure that may pass is retried by the client. A track the server refused to stream
      // (gone, or not allowed) is told once and skipped, as one the browser cannot play.
      onLoadError: (entry, _error, willRetry) => {
        if (willRetry || client.getSnapshot().session.current?.id !== entry.id) return
        failCurrent(client, status, picked, entry.id, store.get(entry.trackId, entry.albumId)?.title)
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
  const [status] = useState(() => new StatusLine())
  const [picked] = useState(() => new Picked())
  const [{ client, setQuality }] = useState(() => createSession(api, socket!, tab.device, engine, store, status, picked))
  const [listening] = useState(() => new Listening(client, engine))
  const [clock] = useState(() => new PositionClock(() => listening.position()))
  const serverNow = useMemo(() => () => client.serverNow(), [client])
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot)
  // What can be heard follows the engine as well as the session: the session says playing long before the first sample.
  const subscribeAudible = useCallback((listener: () => void) => {
    const unsubscribe = [client.subscribe(listener), engine.subscribe(listener)]
    return () => unsubscribe.forEach(undo => undo())
  }, [client, engine])
  const audible = useSyncExternalStore(subscribeAudible, () => listening.audible())
  const [, summariesArrived] = useReducer((count: number) => count + 1, 0)

  useEffect(() => {
    client.start()
    return () => client.dispose()
  }, [client])
  useEffect(() => () => status.dispose(), [status])
  const statusLine = useSyncExternalStore(status.subscribe, status.get)
  useEffect(() => store.subscribe(summariesArrived), [store])

  useEffect(() => {
    if (!settings) return
    setQuality(settings.qualityWifi)
    client.setNormalization(settings.normalization)
    client.setNormalizationTarget(settings.normalizationTarget ?? -18)
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
  })
  const track = current && (fresh.data?.id === current.trackId ? fresh.data : stored)
  const lyrics = useQuery({
    queryKey: queryKeys.lyrics(track?.id ?? ''),
    queryFn: () => api.catalog.lyrics(track!.id),
    enabled: Boolean(track?.hasLyrics),
    staleTime: Infinity,
  })


  // The player says a radio is starting, and why one did not; a second press while one starts does nothing.
  const radio = useMutation({
    mutationFn: (seed: RadioSeed) => (seed.type === 'artist' ? api.radio.artist(seed.id) : seed.type === 'sonic' ? api.radio.sonic(seed.id) : api.radio.track(seed.id)),
    onMutate: () => status.show({ message: 'Starting radio…', tone: 'busy', key: RADIO_STATUS }),
    onSuccess: ({ tracks, context }) => {
      status.clear(RADIO_STATUS)
      picked.set(null)
      client.dispatch({ type: 'playTracks', tracks, startIndex: 0, shuffle: false, seed: randomSeed(), context, startedFrom: 'collection' })
    },
    onError: (_error, seed) => status.show({
      message: seed.type === 'artist' ? 'Couldn’t start this artist’s radio' : 'Couldn’t start a radio from this song',
      detail: 'Try again.',
      tone: 'error',
      key: RADIO_STATUS,
    }, STATUS_ERROR_MS),
    onSettled: () => { radioBusy.current = false },
  })
  const radioPending = radio.isPending ? radio.variables ?? null : null
  const radioBusy = useRef(false)
  const startRadioNow = radio.mutate
  const startRadio = useCallback((seed: RadioSeed) => {
    if (radioBusy.current) return
    radioBusy.current = true
    startRadioNow(seed)
  }, [startRadioNow])

  const controls = useMemo<PlayerControls>(() => {
    const dispatch = (command: SessionCommand) => client.dispatch(command)
    const latest = () => client.getSnapshot()
    const shown = (entries: readonly QueueEntry[]) => entries.filter(entry => store.get(entry.trackId, entry.albumId))
    const playable = (track: TrackSummary) => isPlayable(track, viewer)
    const titleOf = (entry: QueueEntry | undefined) => entry && store.get(entry.trackId, entry.albumId)?.title
    /** Sends a queue edit and, where the server can take it back, says so on the status line with Undo. */
    const undoable = (command: SessionCommand, message: string) => {
      const commandId = dispatch(command)
      if (!commandId || !latest().canUndo) return
      const run = () => {
        status.clear(UNDO_STATUS)
        dispatch({ type: 'undo', commandId })
      }
      status.show({ message, tone: 'info', key: UNDO_STATUS, action: { label: 'Undo', run } }, STATUS_UNDO_MS)
    }
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
      setSleepTimer: timer => dispatch({ type: 'setSleepTimer', timer }),
      playTracks: (tracks, startIndex = 0, context, options = {}) => {
        // A song by name stays put if it cannot be had; a list played whole moves on past it.
        const byName = !options.shuffle && !options.collection
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
          startedFrom: byName ? 'song' : 'collection',
        })
        picked.set(byName ? latest().session.current?.id ?? null : null)
      },
      enqueue: (tracks, placement) => {
        const seeds = tracks.filter(playable).slice(0, MAX_SEEDS).map(seedOf)
        if (!seeds.length) return
        store.prime(tracks)
        const first = tracks.find(playable)
        const message = seeds.length > 1 ? `Added ${seeds.length} songs to the queue` : placement === 'next' ? `“${first!.title}” plays next` : `Added “${first!.title}” to the queue`
        undoable({ type: 'enqueue', tracks: seeds, placement }, message)
      },
      startRadio,
      playEntry: entryId => {
        const { queue: lists } = latest()
        const past = lists.history.find(entry => entry.id === entryId)
        if (!past) dispatch({ type: 'playQueueEntry', entryId })
        else {
          // History is not playable in place: queue the track again and play that entry.
          dispatch({ type: 'enqueue', tracks: [{ trackId: past.trackId, albumId: past.albumId, durationMs: past.durationMs }], placement: 'next' })
          const added = latest().queue.queue[0]
          if (added) dispatch({ type: 'playQueueEntry', entryId: added.id })
        }
        picked.set(latest().session.current?.id ?? null)
      },
      removeEntry: entryId => {
        const { queue: lists } = latest()
        const title = titleOf([...lists.queue, ...lists.autoplayQueue].find(entry => entry.id === entryId))
        undoable({ type: 'removeFromQueue', entryId }, title ? `Removed “${title}”` : 'Removed from the queue')
      },
      moveEntry: (entryId, toIndex) => {
        const { queue: lists } = latest()
        const list = lists.queue.some(entry => entry.id === entryId) ? lists.queue : lists.autoplayQueue
        const target = shown(list)[toIndex]
        if (target) dispatch({ type: 'moveInQueue', entryId, toIndex: list.indexOf(target) })
      },
      clearQueue: () => {
        if (latest().queue.queue.length) undoable({ type: 'clearQueue' }, 'Queue cleared')
        else dispatch({ type: 'clearQueue' })
      },
      clearHistory: () => {
        if (!latest().queue.history.length) return
        dispatch({ type: 'clearHistory' })
        status.show({ message: 'History cleared', tone: 'info', key: ACTION_STATUS }, STATUS_EVENT_MS)
      },
      transfer: deviceId => dispatch({ type: 'transfer', deviceId }),
      prepareHere: () => client.prepareTakeover(),
      detach: () => client.detach(),
      attach: options => client.attach(options),
      renameDevice: name => {
        saveBrowserName(name)
        client.rename(browserName())
      },
      tell: ({ tone, ...line }) => status.show({ ...line, tone, key: ACTION_STATUS }, tone === 'error' ? STATUS_ERROR_MS : STATUS_EVENT_MS),
    }
  }, [client, engine, listening, clock, store, tab, startRadio, viewer, picked, status])

  usePlaybackNotices(client, store, status)
  useFreshSummaries(client, store, socket!)
  useEngineErrors(engine, client, store, status, picked)
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
    history: hydrate(store, queue.history),
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
    status: statusLine,
    radioPending,
    outage: snapshot.outage,
    signal: snapshot.signal,
    sleepTimer: session.sleepTimer,
    canSetSleepTimer: snapshot.canSetSleepTimer,
    serverNow,
  }
  const nowPlaying = useNowPlayingStore(state)

  return (
    <PlayerControlsContext value={controls}>
      <PlayerContext value={{ state, controls }}>
        <RadioPendingContext value={radioPending}>
          <NowPlayingContext value={nowPlaying}>
            <PositionContext value={clock}>{children}</PositionContext>
          </NowPlayingContext>
        </RadioPendingContext>
      </PlayerContext>
    </PlayerControlsContext>
  )
}

/**
 * Status keys: a line about one song, a stop (kept until playback resumes), a radio starting,
 * and what a command from elsewhere in the app said (`tell`).
 */
const NOTICE_STATUS = 'notice'
const STOP_STATUS = 'stop'
const RADIO_STATUS = 'radio'
const ACTION_STATUS = 'action'
const UNDO_STATUS = 'undo'
/**
 * How long a skipped song's notice waits. When the provider is down the server fails the
 * current and next songs in one moment and then stops, and the stop's one notice says it
 * all: the songs' own notices are dropped if it comes within this time.
 */
const STOP_GRACE_MS = 1500

/**
 * Says when music could not be had, worded as on every client (client-core's
 * `PlaybackNoticeWatcher`), on the player's status line: a line per song skipped as its turn
 * came, one that counts a run of songs the provider does not have, and one when playback
 * stops on a failure instead (an outage, failures in a row, or nothing left that is
 * available) or stays on a song that could not play. A stop stays until playback resumes or
 * moves on; the rest go away by themselves. A skipped song is told a moment late, so the
 * songs an outage fails just before it stops are not told beside the stop.
 */
function usePlaybackNotices(client: SessionClient, store: TrackStore, status: StatusLine) {
  useEffect(() => {
    const watcher = new PlaybackNoticeWatcher(trackId => client.failureOf(trackId))
    const tell = (notice: PlaybackNotice, key: string, tone: PlayerStatus['tone'] = 'info') =>
      status.show({ ...notice, tone, key }, key === STOP_STATUS ? undefined : STATUS_EVENT_MS)
    const held = new Set<ReturnType<typeof setTimeout>>()
    /** The current entry a stop was told on, while it shows. */
    let stoppedOn: string | null | undefined
    const look = () => {
      const snapshot = client.getSnapshot()
      if (stoppedOn !== undefined && (snapshot.session.playing || (snapshot.session.current?.id ?? null) !== stoppedOn)) {
        stoppedOn = undefined
        status.clear(STOP_STATUS)
      }
      const stop = (notice: PlaybackNotice, tone: PlayerStatus['tone'] = 'info') => {
        stoppedOn = snapshot.session.current?.id ?? null
        tell(notice, STOP_STATUS, tone)
      }
      const { skipped, unavailable, stopped } = watcher.update(snapshot)
      for (const { entry, failure, held: stayed } of skipped) {
        const notice = skipNotice(store.get(entry.trackId, entry.albumId)?.title, failure, stayed)
        if (stayed) {
          stop(notice, 'error')
          continue
        }
        const timer = setTimeout(() => {
          held.delete(timer)
          tell(notice, NOTICE_STATUS)
        }, STOP_GRACE_MS)
        held.add(timer)
      }
      // One line for a run of songs not to be had, and for the stop that may end it.
      if (unavailable) tell(unavailableNotice(unavailable, store.get(unavailable.entry.trackId, unavailable.entry.albumId)?.title), NOTICE_STATUS)
      if (stopped) {
        for (const timer of held) clearTimeout(timer)
        held.clear()
        stop(stopped)
      }
    }
    look()
    const unsubscribe = client.subscribe(look)
    return () => {
      unsubscribe()
      for (const timer of held) clearTimeout(timer)
    }
  }, [client, store, status])
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

/** A track the browser cannot play (gone, or a format it refuses) is reported and skipped, unless it was just picked. */
function useEngineErrors(engine: WebPlayerEngine, client: SessionClient, store: TrackStore, status: StatusLine, picked: Picked) {
  useEffect(() => engine.subscribe(event => {
    if (event.type !== 'error' || event.message === AUDIO_BLOCKED_MESSAGE) return
    const { session, isActiveDevice, connection } = client.getSnapshot()
    if (!isActiveDevice || connection !== 'online' || session.current?.id !== event.entryId) return
    failCurrent(client, status, picked, session.current.id, store.get(session.current.trackId, session.current.albumId)?.title, event.message)
  }), [engine, client, store, status, picked])
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
