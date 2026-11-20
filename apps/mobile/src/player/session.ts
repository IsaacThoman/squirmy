import type {
  DeviceInfo, QueueEntry, QueueSeed, RepeatMode, SessionQueue, SessionState, StreamQuality, TrackSummary,
  UserSettings,
} from '@squirmy/contracts';

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
export function deviceRows(devices: readonly DeviceInfo[], thisDevice: DeviceInfo, activeDeviceId: string | null): DeviceRow[] {
  const others = devices.filter(device => device.id !== thisDevice.id && device.canPlay);
  return [thisDevice, ...others].map(device => {
    const active = device.id === activeDeviceId;
    const isThisDevice = device.id === thisDevice.id;
    return {
      id: device.id,
      name: isThisDevice ? `This ${thisDevice.kind === 'ios' ? 'iPhone' : 'phone'}` : device.name,
      subtitle: active ? 'Playing' : isThisDevice ? 'This device' : kindName(device.kind),
      icon: deviceIcon(device.kind),
      active,
      canPlay: device.canPlay,
      isThisDevice,
    };
  });
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

/** Finds an entry anywhere in the session by id. */
export function findEntry(session: Entries, entryId: string): QueueEntry | undefined {
  return allEntries(session).find(entry => entry.id === entryId);
}
