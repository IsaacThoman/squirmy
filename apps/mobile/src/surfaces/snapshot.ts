/**
 * What the widgets show and Siri suggests from, built from the session and Home. Plain data,
 * so it is tested without React Native; `SystemSurfaces` writes it into the App Group.
 */
import { artworkUrl } from '@squirmy/client-core';
import type { Artwork, HomeResponse, QueueEntry, TrackSummary } from '@squirmy/contracts';
import type { SurfaceItem, SurfaceNowPlaying, SurfaceSnapshot } from '../../modules/app-intents';
import { homeItemCollection } from '../library/collections';

/** Covers are fetched at this size and made smaller on the phone. */
const artworkSize = 600;
/** A large widget shows eight. */
export const recentLimit = 8;

export type SnapshotInput = {
  signedIn: boolean;
  serverUrl: string;
  now: number;
  playing: {
    current: Pick<QueueEntry, 'trackId' | 'durationMs'> | null;
    track: TrackSummary | undefined;
    playing: boolean;
    positionMs: number;
    /** The other device's name while it plays and this phone is a remote; null otherwise. */
    device: string | null;
  };
  home: HomeResponse | undefined;
  /** A cover kept on the phone (downloads, the streaming cache), as a file URL. */
  keptArtwork: (artworkId: string) => string | null;
};

export type SnapshotOutput = { snapshot: SurfaceSnapshot; artwork: Record<string, string> };

export function surfaceSnapshot(input: SnapshotInput): SnapshotOutput {
  const artwork: Record<string, string> = {};
  const cover = (art: Artwork | null | undefined): Pick<SurfaceItem, 'artwork' | 'color'> => {
    if (!art) return {};
    const name = `${art.id}.jpg`;
    const source = input.keptArtwork(art.id) ?? artworkUrl(input.serverUrl, art, artworkSize);
    if (source) artwork[name] = source;
    return { ...(source ? { artwork: name } : {}), ...(art.color ? { color: art.color } : {}) };
  };
  if (!input.signedIn) {
    return { snapshot: { version: 1, signedIn: false, nowPlaying: null, recent: [], updatedAt: input.now }, artwork };
  }
  return {
    snapshot: {
      version: 1,
      signedIn: true,
      nowPlaying: nowPlaying(input, cover),
      recent: recentItems(input.home).map(({ art, ...item }) => ({ ...item, ...cover(art) })),
      updatedAt: input.now,
    },
    artwork,
  };
}

function nowPlaying({ playing, now }: SnapshotInput, cover: (art: Artwork | null | undefined) => Pick<SurfaceItem, 'artwork' | 'color'>): SurfaceNowPlaying | null {
  const { current, track } = playing;
  if (!current || !track) return null;
  return {
    title: track.title,
    ...(track.artistCredit ? { artist: track.artistCredit } : {}),
    ...(track.album ? { album: track.album.title } : {}),
    ...cover(track.album?.artwork),
    playing: playing.playing,
    positionMs: Math.max(0, Math.round(playing.positionMs)),
    anchorAt: now,
    durationMs: current.durationMs || track.durationMs,
    ...(playing.device ? { device: playing.device } : {}),
  };
}

type RecentItem = Omit<SurfaceItem, 'artwork' | 'color'> & { art: Artwork | null | undefined };

/** Home's Jump back in, as the widget's tiles: each opens its page in the Home tab. */
export function recentItems(home: HomeResponse | undefined): RecentItem[] {
  const section = home?.sections.find(candidate => candidate.kind === 'items' && candidate.id === 'jump-back-in');
  if (section?.kind !== 'items') return [];
  const link = (page: string, id: string) => `${page}/${id}`;
  return section.items.flatMap((item): RecentItem[] => {
    const collection = homeItemCollection(item, link);
    if (!collection || collection.kind === 'recent') return [];
    const id = collection.kind === 'liked' || collection.kind === 'radio' ? collection.key : `${collection.kind}:${collection.key}`;
    return [{
      id, kind: collection.kind, title: collection.title, subtitle: collection.subtitle,
      link: String(collection.href), art: collection.artwork ?? collection.artworks?.[0],
    }];
  }).slice(0, recentLimit);
}

/**
 * The snapshot without the clock, to tell whether anything shown changed: a playing song's
 * position moves on its own, so only a jump (a seek, a stall) counts.
 */
export function snapshotKey({ snapshot, artwork }: SnapshotOutput): string {
  const shown = snapshot.nowPlaying && {
    ...snapshot.nowPlaying,
    anchorAt: 0,
    // Where the song would be at a fixed time, rounded to a few seconds: steady while it plays.
    positionMs: Math.round((snapshot.nowPlaying.playing
      ? snapshot.nowPlaying.positionMs - snapshot.nowPlaying.anchorAt
      : snapshot.nowPlaying.positionMs) / 3000),
  };
  return JSON.stringify([{ ...snapshot, updatedAt: 0, nowPlaying: shown }, artwork]);
}
