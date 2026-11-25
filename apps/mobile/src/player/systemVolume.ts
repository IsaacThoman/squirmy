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

/** How long the system may take to tell of a level this phone set it to. */
export const echoMs = 1000;

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
 * iOS tells of a level the phone set a little later. By then another device dragging the
 * slider has usually moved the session on, so those notices are recognised as the phone's own
 * and not sent back: sending them made the session, and every slider showing it, jump back and
 * forth between the old level and the new.
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
  /** Levels this phone set the system to whose notices may still come, oldest first. */
  let echoes: { level: number; at: number }[] = [];

  const sessionLevel = () => session.getSnapshot().session.volumes[deviceId];
  const flush = () => {
    timer = null;
    if (pending === null) return;
    const value = pending;
    pending = null;
    reportedAt = timers.now();
    send({ type: 'setVolume', deviceId, value });
  };
  const echoed = (volume: number) => {
    const now = timers.now();
    echoes = echoes.filter(echo => now - echo.at < echoMs);
    const index = echoes.findIndex(echo => same(echo.level, volume));
    if (index < 0) return false;
    // The system tells of levels in the order they were set: earlier ones will not come now.
    echoes = echoes.slice(index + 1);
    return true;
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

  const stopSystem = system.subscribe(volume => {
    if (!echoed(volume)) report(volume);
  });
  const stopSession = session.subscribe(() => {
    const snapshot = session.getSnapshot();
    const becameActive = snapshot.isActiveDevice && !active;
    active = snapshot.isActiveDevice;
    if (becameActive) return report(system.get());
    if (!active || pending !== null || timers.now() - reportedAt < settleMs) return;
    const wanted = sessionLevel();
    // The system may not show a level just set yet: compare with that level, not set it twice.
    const now = timers.now();
    const expected = echoes.findLast(echo => now - echo.at < echoMs)?.level ?? system.get();
    if (wanted === undefined || same(wanted, expected)) return;
    echoes.push({ level: wanted, at: now });
    system.set(wanted);
  });
  if (active) report(system.get());

  return () => {
    stopSystem();
    stopSession();
    if (timer !== null) timers.clearTimeout(timer);
  };
}
