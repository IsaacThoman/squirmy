import { type SessionOutage, UNAVAILABLE_LABEL, type Viewer } from '@squirmy/client-core';
import type {
  DeviceInfo, QueueEntry, QueueSeed, RepeatMode, SessionQueue, SessionState, StreamQuality, TrackSummary,
  UserSettings,
} from '@squirmy/contracts';
import { unavailableReason } from '../downloads/model';

/** The SF Symbol for a kind of device. */
export function deviceIcon(kind: DeviceInfo['kind']): string {
  switch (kind) {
    case 'ios':
    case 'android': return 'iphone';
    case 'web':
    case 'desktop': return 'laptopcomputer';
    case 'other': return 'hifispeaker.fill';
  }
}

export type DeviceRow = {
  id: string;
  name: string;
  subtitle: string;
  icon: string;
  /** Plays the session's audio now. */
  active: boolean;
  canPlay: boolean;
  isThisDevice: boolean;
};

/**
 * The devices sheet: this device first, then the user's other connected devices that
 * can play. The server lists a device only while it is connected, so this one is added
 * when the list has not caught up with it yet (or the app is offline).
 */
export function deviceRows(devices: readonly DeviceInfo[], thisDevice: DeviceInfo, activeDeviceId: string | null, now = Date.now()): DeviceRow[] {
  const others = devices.filter(device => device.id !== thisDevice.id && device.canPlay);
  // The session can name a player before the device list has caught up with it (it just
  // connected). Without a row of its own the output would fall back to this phone, and the
  // sheet would say "Playing on This iPhone" while the phone is silent.
  const known = activeDeviceId === null || activeDeviceId === thisDevice.id || others.some(device => device.id === activeDeviceId);
  if (!known) others.push({ id: activeDeviceId, name: 'Another device', kind: 'other', canPlay: true, isActive: true });
  return [thisDevice, ...others].map(device => {
    const active = device.id === activeDeviceId;
    const isThisDevice = device.id === thisDevice.id;
    return {
      id: device.id,
      name: isThisDevice ? `This ${thisDevice.kind === 'ios' ? 'iPhone' : 'phone'}` : device.name,
      subtitle: active ? 'Playing' : isThisDevice ? 'This device' : `${kindName(device.kind)}${idleFor(device, now)}`,
      icon: deviceIcon(device.kind),
      active,
      canPlay: device.canPlay,
      isThisDevice,
    };
  });
}

/**
 * " · Active 3 h ago" for a device that has been quiet a while: what tells apart two
 * devices of the same name, such as a browser tab left open on another computer. Nothing
 * for one in use now, or from a server that does not say.
 */
function idleFor(device: DeviceInfo, now: number): string {
  if (device.lastSeenAt === undefined) return '';
  const minutes = Math.floor((now - device.lastSeenAt) / 60_000);
  if (minutes < 5) return '';
  if (minutes < 60) return ` · Active ${minutes} min ago`;
  if (minutes < 48 * 60) return ` · Active ${Math.floor(minutes / 60)} h ago`;
  return ` · Active ${Math.floor(minutes / (24 * 60))} days ago`;
}

function kindName(kind: DeviceInfo['kind']): string {
  switch (kind) {
    case 'ios': return 'iPhone';
    case 'android': return 'Android';
    case 'web': return 'Web browser';
    case 'desktop': return 'Computer';
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

/** Entries that were preparing before and have failed since: the server could not fetch them. */
export function newlyFailed(before: Entries, after: Entries): QueueEntry[] {
  const preparing = new Set(allEntries(before).filter(entry => entry.state === 'preparing').map(entry => entry.id));
  return allEntries(after).filter(entry => entry.state === 'failed' && preparing.has(entry.id));
}

/** A notice: a short line, and an optional quieter one under it. */
export type NoticeText = { message: string; detail?: string };

/**
 * The notice for a session that paused because music could not be had, worded as the web
 * app's: with the server's reason when it gave one (its provider is failing).
 */
export function outageNotice(outage: Pick<SessionOutage, 'reason'> | null | undefined): NoticeText {
  return { message: 'Can’t load music right now', detail: outage?.reason ? `${outage.reason} Playback is paused.` : 'Playback is paused.' };
}

type Watched = Entries & Pick<SessionState, 'playing'> & { outage?: SessionOutage | null };

/**
 * What to tell the listener after a session change. `skipped`: entries that just failed and
 * were the current entry or the next one, one notice each. A failure further down is only
 * shown gray in the queue and skipped quietly when reached; announcing every failed
 * prefetch would turn a provider outage into a stream of notices. `outage`: the session
 * paused on a current entry that failed (the server does that after several failures in a
 * row, or at once when its provider is failing), which gets the one "Can't load music right
 * now" instead of a notice per track. The session client hands over the server's reason
 * (`outage`) with the pause itself, so it is told then; one that comes later still is.
 */
export function failureNotices(before: Watched, after: Watched): { skipped: QueueEntry[]; outage: NoticeText | null } {
  const failed = newlyFailed(before, after);
  const heldOn = after.current?.state === 'failed' && !after.playing ? after.current.id : null;
  const near = new Set([before.current?.id, before.queue[0]?.id ?? before.autoplayQueue[0]?.id].filter(Boolean));
  const told = after.outage && after.outage !== before.outage ? after.outage : null;
  const paused = heldOn !== null && failed.some(entry => entry.id === heldOn);
  return {
    skipped: failed.filter(entry => near.has(entry.id) && entry.id !== heldOn),
    outage: told || paused ? outageNotice(told ?? after.outage) : null,
  };
}

/**
 * A queue row's second line and whether it is gray. A waiting or fetching entry looks like
 * any other (its artist); one the server could not fetch says "Not available", and offline
 * one that is not on the phone says "Not downloaded". An entry whose summary has not loaded
 * yet is not grayed, so rows do not flash.
 */
export function queueRow(entry: Pick<QueueEntry, 'state'>, track: Pick<TrackSummary, 'availability' | 'artistCredit'> | undefined, {
  playable, offline, viewer,
}: { playable: boolean; offline: boolean; viewer: Viewer | null | undefined }): { detail: string; unavailable: boolean } {
  if (entry.state === 'failed') return { detail: UNAVAILABLE_LABEL, unavailable: true };
  if (track && !playable) return { detail: unavailableReason(track, offline, viewer), unavailable: true };
  return { detail: track?.artistCredit ?? '', unavailable: false };
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
