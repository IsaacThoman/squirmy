import type { SessionCommand } from '@squirmy/contracts';

export type CarPlayStartCommand = Extract<SessionCommand, { type: 'playTracks' | 'playQueueEntry' }>;

type Output = { activeDeviceId: string | null; playing: boolean };

/** Move a remote session to the phone before selecting new audio. The old song stays paused
 * during the handoff, including while the server prepares the new selection. */
export function carPlayStart(session: Output, deviceId: string, command: CarPlayStartCommand, atomic = false): SessionCommand[] {
  if (atomic) return [{ ...command, playHere: true }];
  if (session.activeDeviceId === null || session.activeDeviceId === deviceId) return [command];
  return [{ type: 'transfer', deviceId, play: false }, command];
}

/** A car may send Play on connection. Leave another device's running audio alone. */
export function carPlayResume(session: Output, deviceId: string, atomic = false): SessionCommand[] {
  if (atomic) return [{ type: 'play', playHere: true }];
  if (session.activeDeviceId && session.activeDeviceId !== deviceId) {
    if (session.playing) return [];
    return [
      { type: 'transfer', deviceId, play: false },
      { type: 'play' },
    ];
  }
  return [{ type: 'play' }];
}
