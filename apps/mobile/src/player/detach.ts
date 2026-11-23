import type { DeviceInfo, SessionQueue, SessionState } from '@squirmy/contracts';
import { deviceIcon } from './session';

/** The marker a detached phone shows where "Playing on …" would be. */
export const DETACHED_LABEL = 'Only on this device';
/** Two chain links, crossed out: "not linked", beside the app's other device symbols. */
export const DETACHED_SYMBOL = 'personalhotspot.slash';

/** What a refused detach or attach says. Everything stays as it was. */
export function moveFailure(move: 'detach' | 'attach', error: string): string {
  switch (error) {
    case 'offline': return 'Can’t do that while offline.';
    case 'too_many_detached': return 'Eight devices are already playing separately. Re-attach one first.';
    case 'timeout':
    case 'disconnected':
    case 'internal_error': return move === 'detach' ? 'Couldn’t play separately. Try again.' : 'Couldn’t rejoin. Try again.';
    default: return move === 'detach' ? 'Couldn’t play separately.' : 'Couldn’t rejoin. Try again.';
  }
}

/**
 * The device sheet's header while detached. It names no state in its title, which says the
 * same as the mini-player's marker, so it is right whether the phone is playing or paused.
 */
export function detachedHeader(track: { title: string; artistCredit: string } | undefined, playing: boolean): { title: string; subtitle: string } {
  if (!track) return { title: DETACHED_LABEL, subtitle: 'Nothing playing' };
  return { title: DETACHED_LABEL, subtitle: `${playing ? '' : 'Paused · '}${track.title} · ${track.artistCredit}` };
}

/** "Bring this queue with me" needs something to bring; the server refuses an empty one (`nothing_to_bring`). */
export function hasQueueToBring(session: Pick<SessionState, 'current'>, queue: Pick<SessionQueue, 'queue'>): boolean {
  return session.current !== null || queue.queue.length > 0;
}

export type SeparateRow = { id: string; name: string; icon: string; subtitle: string };

/**
 * The "Playing separately" group: every other device that is detached, with what it plays.
 * It answers "why didn't the kitchen change?", so it shows on every device.
 */
export function separateRows(
  devices: readonly DeviceInfo[], thisDeviceId: string,
  title: (trackId: string, albumId: string | null) => string | undefined,
): SeparateRow[] {
  return devices.filter(device => device.detached && device.id !== thisDeviceId).map(device => {
    const { playing, trackId, albumId } = device.detached!;
    const name = trackId ? title(trackId, albumId) : undefined;
    const subtitle = !trackId ? 'Nothing playing' : `${name ?? 'A song'}${playing ? '' : ' · Paused'}`;
    return { id: device.id, name: device.name, icon: deviceIcon(device.kind), subtitle };
  });
}
