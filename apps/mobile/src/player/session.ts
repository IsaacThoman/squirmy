import { type AwayDevice, deviceLabel, idleHint, listedDevices, reconnectingText, UNAVAILABLE_LABEL, type Viewer } from '@squirmy/client-core';
import type {
  DeviceInfo, PlaybackQuery, QueueEntry, QueueSeed, RepeatMode, SessionQueue, SessionState, StreamQuality, TrackSummary,
  UserSettings,
} from '@squirmy/contracts';
import { unavailableReason } from '../downloads/model';

/** The SF Symbol for a kind of device. */
export function deviceIcon(kind: DeviceInfo['kind']): string {
  switch (kind) {
    case 'ios':
    case 'android': return 'iphone';
    case 'tv': return 'appletv.fill';
    case 'web':
    case 'desktop': return 'laptopcomputer';
    case 'speaker':
    case 'other': return 'hifispeaker.fill';
  }
}

export type DeviceRow = {
  id: string;
  name: string;
  subtitle: string;
  icon: string;
  /** The session's audio is on this device, playing or paused. */
  active: boolean;
  canPlay: boolean;
  isThisDevice: boolean;
  /** "Reconnecting to …" while this is the active device and it went away (the client's `away`); else null. */
  reconnecting: string | null;
};

/**
 * The devices sheet: this device first, then the user's other live devices that can play,
 * one row per browser rather than per tab (client-core `listedDevices`). The server lists a
 * device only while it is live, so this one is added when the list has not caught up with
 * it yet (or the app is offline).
 *
 * The active device can be missing from the list: it went away and the session waits for
 * it (`away`, from the session client). It keeps a row so the output still names it, but
 * one that says it is reconnecting and cannot be picked.
 */
export function deviceRows(
  devices: readonly DeviceInfo[], thisDevice: DeviceInfo,
  { activeDeviceId, playing, away = null, onTv = false }: Pick<SessionState, 'activeDeviceId' | 'playing'> & { away?: AwayDevice | null; onTv?: boolean }, now = Date.now(),
): DeviceRow[] {
  const listed = listedDevices(devices, thisDevice.id);
  const others = listed.filter(device => device.id !== thisDevice.id && device.canPlay);
  const known = activeDeviceId === null || activeDeviceId === thisDevice.id || others.some(device => device.id === activeDeviceId);
  const waiting = !known && away?.id === activeDeviceId ? away : null;
  // The session can also name a player before the device list has caught up with it (it just
  // connected). Without a row of its own the output would fall back to this phone, and the
  // sheet would say "Playing on This iPhone" while the phone is silent.
  if (!known) others.push({ ...(waiting?.device ?? { name: 'Another device', kind: 'other' as const }), id: activeDeviceId, canPlay: !waiting, isActive: true });
  const thisName = `This ${onTv ? 'Apple TV' : thisDevice.kind === 'ios' ? 'iPhone' : 'phone'}`;
  return [thisDevice, ...others].map(device => {
    const active = device.id === activeDeviceId;
    const isThisDevice = device.id === thisDevice.id;
    const label = deviceLabel(device, listed, thisDevice.id, thisName, now);
    const reconnecting = waiting && device.id === waiting.id ? reconnectingText(waiting.device ? label : null) : null;
    return {
      id: device.id,
      name: reconnecting && !waiting?.device ? 'Playing device' : label.name,
      // The active device keeps the session while paused, so its row says which it is, as the web app's device menu does.
      subtitle: reconnecting ? 'Reconnecting…' : active ? playing ? 'Playing' : 'Paused' : isThisDevice ? 'This device' : [kindName(device.kind), idleHint(device.lastSeenAt, now), label.hint].filter(Boolean).join(' · '),
      icon: isThisDevice && onTv ? 'appletv.fill' : deviceIcon(device.kind),
      active,
      canPlay: device.canPlay,
      isThisDevice,
      reconnecting,
    };
  });
}

/** "Playing on …" (or `verb` on …) for the output device, or "Reconnecting to …" while the session waits for it. */
export function whereItPlays(output: Pick<DeviceRow, 'name' | 'reconnecting'>, verb: 'Playing' | 'Paused' = 'Playing'): string {
  return output.reconnecting ?? `${verb} on ${output.name}`;
}

function kindName(kind: DeviceInfo['kind']): string {
  switch (kind) {
    case 'ios': return 'iPhone';
    case 'android': return 'Android';
    case 'tv': return 'Apple TV';
    case 'web': return 'Web browser';
    case 'desktop': return 'Computer';
    case 'speaker': return 'Squirmy speaker';
    case 'other': return 'Speaker';
  }
}

/**
 * The device the transport's output button names: the active one, or this device when
 * nothing plays (pressing play here makes it the active one).
 */
export function outputDevice(rows: readonly DeviceRow[]): DeviceRow {
  return rows.find(row => row.active) ?? rows.find(row => row.isThisDevice)!;
}

/** Another device plays, so this one is a remote control with no sound of its own. */
export function isRemote(state: Pick<SessionState, 'activeDeviceId'>, thisDeviceId: string): boolean {
  return state.activeDeviceId !== null && state.activeDeviceId !== thisDeviceId;
}

/** What `GET /tracks/:id/playback` should ask for on this network: Wi-Fi rules unless on cellular. */
export function qualityFor(settings: Pick<UserSettings, 'qualityWifi' | 'qualityCellular'>, network: 'wifi' | 'cellular' | 'other'): StreamQuality {
  return network === 'cellular' ? settings.qualityCellular : settings.qualityWifi;
}

/** Codecs AVPlayer decodes natively. Opus and Vorbis would need a transcode on iOS. */
export function codecsFor(platform: string): string {
  return platform === 'ios' ? 'flac,alac,aac,mp3,wav,aiff' : 'flac,aac,mp3,opus,vorbis,wav';
}

export type PlaybackRequest = Pick<PlaybackQuery, 'codecs' | 'containers' | 'engine'>;

/**
 * What `/tracks/:id/playback` asks for. The native engine, given its codec probe, reads the
 * server's fragmented MP4 transcodes, with exact gapless numbers and Opus where the device
 * decodes it; it says `engine: 'native'` so a device without Opus is not taken for a browser.
 * Any other player gets what `codecsFor` lists, in today's profiles.
 */
export function playbackRequestFor(platform: string, probeCodecs?: () => readonly string[]): PlaybackRequest {
  return probeCodecs ? { codecs: probeCodecs().join(','), containers: 'fmp4', engine: 'native' } : { codecs: codecsFor(platform) };
}

/** `none` is catalog only: shown gray, never queued. */
export function isPlayable(track: Pick<TrackSummary, 'availability'>): boolean {
  return track.availability !== 'none';
}

/** The seed a track is queued with. On-demand tracks start out preparing. */
export function seedOf(track: TrackSummary): QueueSeed {
  return {
    trackId: track.id,
    albumId: track.album?.id ?? null,
    durationMs: track.durationMs,
    state: track.availability === 'on_demand' ? 'preparing' : 'ready',
  };
}

/**
 * The playable tracks of a list as seeds, and where `start` (an index into `tracks`)
 * lands among them. A gray start falls through to the next playable track. `playable`
 * decides what counts, e.g. only downloads while offline.
 */
export function playableSeeds(tracks: readonly TrackSummary[], start = 0, playable: (track: TrackSummary) => boolean = isPlayable): { seeds: QueueSeed[]; startIndex: number } {
  const seeds: QueueSeed[] = [];
  let startIndex = -1;
  tracks.forEach((track, index) => {
    if (!playable(track)) return;
    if (startIndex < 0 && index >= start) startIndex = seeds.length;
    seeds.push(seedOf(track));
  });
  return { seeds, startIndex: Math.max(0, startIndex) };
}

const repeatCycle: Record<RepeatMode, RepeatMode> = { off: 'all', all: 'one', one: 'off' };

export function nextRepeat(mode: RepeatMode): RepeatMode {
  return repeatCycle[mode];
}

type Entries = Pick<SessionState, 'current'> & Pick<SessionQueue, 'queue' | 'history' | 'autoplayQueue'>;

function allEntries(session: Entries): QueueEntry[] {
  return [...(session.current ? [session.current] : []), ...session.queue, ...session.autoplayQueue, ...session.history];
}

/**
 * A queue row's second line and whether it is gray. A waiting or fetching entry looks like
 * any other (its artist); one the server could not fetch says "Not available", and offline
 * one that is not on the phone says "Not downloaded". An entry whose summary has not loaded
 * yet is not grayed, so rows do not flash.
 */
export function queueRow(entry: Pick<QueueEntry, 'state'>, track: (Pick<TrackSummary, 'availability' | 'artistCredit'> & { explicit?: boolean | null }) | undefined, {
  playable, offline, viewer,
}: { playable: boolean; offline: boolean; viewer: Viewer | null | undefined }): { detail: string; unavailable: boolean } {
  if (entry.state === 'failed') return { detail: UNAVAILABLE_LABEL, unavailable: true };
  if (track && !playable) return { detail: unavailableReason(track, offline, viewer), unavailable: true };
  return { detail: track?.artistCredit ?? '', unavailable: false };
}

/**
 * What a queue row says while its song's summary is missing. Online it is on its way;
 * offline it may not come until the connection does, so the row says why it is empty.
 */
export function pendingQueueRow(offline: boolean): { title: string; detail: string } {
  return offline ? { title: 'Song not loaded', detail: 'Needs a connection' } : { title: 'Loading…', detail: '' };
}

/** Finds an entry anywhere in the session by id. */
export function findEntry(session: Entries, entryId: string): QueueEntry | undefined {
  return allEntries(session).find(entry => entry.id === entryId);
}

/**
 * Where playback goes offline when the current entry can't be streamed: the first
 * downloaded, ready entry that `next` would reach (Up Next, then autoplay suggestions
 * when autoplay is on). Null when there is none.
 */
export function nextDownloaded(
  session: Pick<SessionState, 'autoplay'> & Pick<SessionQueue, 'queue' | 'autoplayQueue'>,
  isDownloaded: (trackId: string) => boolean,
): QueueEntry | null {
  const candidates = session.autoplay ? [...session.queue, ...session.autoplayQueue] : session.queue;
  return candidates.find(entry => entry.state === 'ready' && isDownloaded(entry.trackId)) ?? null;
}

export { upNextDetail, upNextTitle } from '@squirmy/client-core';

/** Where a row of Up next (or of the autoplay suggestions) sits, for what its menu offers. */
export type QueuePosition = { index: number; total: number; autoplay: boolean };

/** What a queued row's menu action does to the entry itself; null for an action that is not about its place. */
export type QueuedEntryCommand = 'playEntry' | 'promote' | 'moveToEnd' | null;

/**
 * A queued row's menu moves the entry, as its swipe does, instead of queueing the song a second
 * time: Play now plays the entry where it is, Play next moves it to the front of Up next, and
 * Add to queue (Move to end) to its end. An autoplay suggestion is copied into the queue and
 * leaves the suggestions, as its swipe does.
 */
export function queuedEntryCommand(actionId: string): QueuedEntryCommand {
  switch (actionId) {
    case 'play': return 'playEntry';
    case 'next': return 'promote';
    case 'last': return 'moveToEnd';
    default: return null;
  }
}

/**
 * A queued row's menu: an Up next entry, already in the queue, offers Move to end in place of
 * Add to queue, and leaves out a move that would keep it where it is (Play next on the first
 * row, Move to end on the last). Autoplay suggestions keep the usual titles: they join the queue.
 */
export function queuedEntryActions<T extends { id: string; title: string }>(
  actions: readonly T[], { index, total, autoplay }: QueuePosition,
): T[] {
  if (autoplay) return [...actions];
  return actions.flatMap(action => {
    if (action.id === 'next') return index > 0 ? [action] : [];
    if (action.id === 'last') return index + 1 < total ? [{ ...action, title: 'Move to end' }] : [];
    return [action];
  });
}
