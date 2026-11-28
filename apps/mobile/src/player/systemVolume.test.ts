import { createInitialSession, splitSession, type SessionClientSnapshot } from '@squirmy/client-core';
import type { SessionCommand } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import { reportIntervalMs, settleMs, syncSystemVolume, type SystemVolumePort } from './systemVolume';

const PHONE = 'phone';

function harness({ active = true, system: start = 0.5, session: level }: { active?: boolean; system?: number; session?: number } = {}) {
  let now = 0;
  let timers: { at: number; run: () => void; id: number }[] = [];
  let serial = 0;
  const clock = {
    now: () => now,
    setTimeout: (run: () => void, ms: number) => {
      const id = ++serial;
      timers.push({ at: now + ms, run, id });
      return id;
    },
    clearTimeout: (id: unknown) => {
      timers = timers.filter(timer => timer.id !== id);
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter(timer => timer.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter(timer => timer !== due);
      now = due.at;
      due.run();
    }
    now = until;
  };

  const { state, queue } = splitSession(createInitialSession());
  let snapshot: SessionClientSnapshot = {
    session: { ...state, volumes: level === undefined ? {} : { [PHONE]: level } }, queue, devices: [], connection: 'online', isActiveDevice: active, detached: false, canDetach: false, canSetSleepTimer: false, canJam: false, outage: null, away: null,
  };
  const sessionListeners = new Set<() => void>();
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
  };
  const update = (change: { volume?: number; active?: boolean }) => {
    snapshot = {
      ...snapshot,
      isActiveDevice: change.active ?? snapshot.isActiveDevice,
      session: change.volume === undefined ? snapshot.session : { ...snapshot.session, volumes: { ...snapshot.session.volumes, [PHONE]: change.volume } },
    };
    for (const listener of [...sessionListeners]) listener();
  };

  let level$ = start;
  const systemListeners = new Set<(volume: number) => void>();
  const sets: number[] = [];
  const system: SystemVolumePort = {
    get: () => level$,
    set: volume => {
      sets.push(volume);
      level$ = volume;
      for (const listener of [...systemListeners]) listener(volume);
    },
    subscribe: listener => {
      systemListeners.add(listener);
      return () => systemListeners.delete(listener);
    },
  };
  const press = (volume: number) => {
    level$ = volume;
    for (const listener of [...systemListeners]) listener(volume);
  };

  const sent: SessionCommand[] = [];
  // Like the session client: a command applies locally at once.
  const send = (command: SessionCommand) => {
    sent.push(command);
    if (command.type === 'setVolume') update({ volume: command.value });
  };
  const stop = syncSystemVolume({ system, session, deviceId: PHONE, send, timers: clock });
  const levels = () => sent.map(command => command.type === 'setVolume' ? command.value : null);
  return { press, update, advance, sets, levels, stop, system };
}

describe('syncSystemVolume', () => {
  it('tells the session the system level when the phone plays', () => {
    expect(harness({ system: 0.4, session: 1 }).levels()).toEqual([0.4]);
    expect(harness({ system: 0.4, session: 0.4 }).levels()).toEqual([]);
    expect(harness({ active: false, system: 0.4, session: 1 }).levels()).toEqual([]);
  });

  it('reports the side buttons, a quick series at a steady pace with the last level always sent', () => {
    const { press, advance, levels } = harness({ system: 0.5, session: 0.5 });
    press(0.5625);
    press(0.625);
    press(0.6875);
    expect(levels()).toEqual([0.5625]);
    advance(reportIntervalMs);
    expect(levels()).toEqual([0.5625, 0.6875]);
  });

  it('does not pull the system volume back while its own reports settle', () => {
    const { press, update, advance, sets } = harness({ system: 0.5, session: 0.5 });
    press(0.75);
    // The server's answer to an earlier level arrives after the press.
    update({ volume: 0.5 });
    advance(reportIntervalMs);
    update({ volume: 0.5 });
    expect(sets).toEqual([]);
  });

  it('moves the system volume when another device changes this phone’s volume', () => {
    const { update, advance, sets, levels } = harness({ system: 0.5, session: 0.5 });
    advance(settleMs);
    update({ volume: 0.25 });
    expect(sets).toEqual([0.25]);
    // The system's own change notice for that move is not sent back.
    expect(levels()).toEqual([]);
  });

  it('leaves the system volume alone while another device plays, and takes it when the phone becomes the player', () => {
    const { update, advance, press, sets, levels } = harness({ active: false, system: 0.5, session: 0.5 });
    advance(settleMs);
    update({ volume: 0.2 });
    expect(sets).toEqual([]);
    press(0.8);
    advance(settleMs);
    update({ active: true });
    expect(levels().at(-1)).toBe(0.8);
  });

  it('stops following', () => {
    const { stop, press, levels } = harness({ system: 0.5, session: 0.5 });
    stop();
    press(0.9);
    expect(levels()).toEqual([]);
  });
});
