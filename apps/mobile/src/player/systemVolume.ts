import type { SessionClientSnapshot } from '@squirmy/client-core';
import type { SessionCommand } from '@squirmy/contracts';

/** The phone's output volume, as the native module gives it. */
export type SystemVolumePort = {
  get: () => number;
  set: (volume: number) => void;
  subscribe: (listener: (volume: number) => void) => () => void;
};

type Session = { getSnapshot: () => SessionClientSnapshot; subscribe: (listener: () => void) => () => void };
type Timers = { now: () => number; setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: unknown) => void };

const systemTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** iOS moves the volume in sixteenths; closer than this is the same level. */
const sameLevel = 0.02;
/** Button presses in a row reach the session at most this often, the last one always. */
export const reportIntervalMs = 150;
/**
 * After this phone reports a level, the session's answers to earlier reports are still on
 * their way; for this long they must not pull the system volume back.
 */
export const settleMs = 1000;

const same = (a: number, b: number) => Math.abs(a - b) < sameLevel;

/**
 * Keeps the session's volume for this phone and the phone's system volume in step, the
 * system volume being the real one (the player itself always plays at full volume):
 *
 * - The side buttons, Control Center or the slider change the system volume: the new level
 *   goes to the session (throttled), so other devices show what the phone really plays at.
 * - Another device changes this phone's volume in the session while the phone plays: the
 *   system volume moves to match.
 * - The phone becomes the playing device: the session takes the system level, which may
 *   have changed while something else played.
 *
 * Returns a function that stops following.
 */
export function syncSystemVolume({ system, session, deviceId, send, timers = systemTimers }: {
  system: SystemVolumePort;
  session: Session;
  deviceId: string;
  send: (command: SessionCommand) => void;
  timers?: Timers;
}): () => void {
  let pending: number | null = null;
  let timer: unknown = null;
  let reportedAt = -Infinity;
  let active = session.getSnapshot().isActiveDevice;

  const sessionLevel = () => session.getSnapshot().session.volumes[deviceId];
  const flush = () => {
    timer = null;
    if (pending === null) return;
    const value = pending;
    pending = null;
    reportedAt = timers.now();
    send({ type: 'setVolume', deviceId, value });
  };
  const report = (volume: number) => {
    const known = sessionLevel();
    if (pending === null && known !== undefined && same(known, volume)) return;
    pending = volume;
    reportedAt = timers.now();
    if (timer === null) {
      flush();
      timer = timers.setTimeout(flush, reportIntervalMs);
    }
  };

  const stopSystem = system.subscribe(report);
  const stopSession = session.subscribe(() => {
    const snapshot = session.getSnapshot();
    const becameActive = snapshot.isActiveDevice && !active;
    active = snapshot.isActiveDevice;
    if (becameActive) return report(system.get());
    if (!active || pending !== null || timers.now() - reportedAt < settleMs) return;
    const wanted = sessionLevel();
    if (wanted !== undefined && !same(wanted, system.get())) system.set(wanted);
  });
  if (active) report(system.get());

  return () => {
    stopSystem();
    stopSession();
    if (timer !== null) timers.clearTimeout(timer);
  };
}
