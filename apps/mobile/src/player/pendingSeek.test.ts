import { createInitialSession, type SessionClientSnapshot } from '@squirmy/client-core';
import type { QueueEntry, SessionCommand } from '@squirmy/contracts';
import { describe, expect, it, vi } from 'vitest';
import { PendingSeek } from './pendingSeek';

const entry = (id: string, state: QueueEntry['state']): QueueEntry => ({ id, trackId: `t.${id}`, albumId: null, durationMs: 200_000, state });

function client(current: QueueEntry | null, positionMs = 0) {
  let session = { ...createInitialSession(), current, playing: true, positionMs };
  const sent: SessionCommand[] = [];
  return {
    sent,
    set: (next: QueueEntry | null) => { session = { ...session, current: next }; },
    getSnapshot: () => ({ session }) as Pick<SessionClientSnapshot, 'session'>,
    getPositionMs: () => session.positionMs,
    dispatch: (command: SessionCommand) => {
      sent.push(command);
      // As the reducer: a seek on a song still being fetched is ignored.
      if (command.type === 'seek' && session.current?.state === 'ready') session = { ...session, positionMs: command.positionMs };
    },
  };
}

describe('PendingSeek', () => {
  it('seeks a ready song at once', () => {
    const fake = client(entry('a', 'ready'));
    const seeks = new PendingSeek(fake);
    seeks.seek(60_000);
    expect(fake.sent).toEqual([{ type: 'seek', positionMs: 60_000 }]);
    expect(seeks.position()).toBe(60_000);
  });

  it('keeps a seek made while the song is fetched, shows it, and sends it once the song is ready', () => {
    const fake = client(entry('a', 'preparing'));
    const seeks = new PendingSeek(fake);
    const listener = vi.fn();
    seeks.subscribe(listener);
    seeks.seek(60_000);
    expect(fake.sent).toEqual([]);
    expect(seeks.position()).toBe(60_000);
    expect(listener).toHaveBeenCalledTimes(1);
    seeks.update();
    expect(fake.sent).toEqual([]);
    fake.set(entry('a', 'ready'));
    seeks.update();
    expect(fake.sent).toEqual([{ type: 'seek', positionMs: 60_000 }]);
    // Read again after it was sent: where it landed, not where the song started.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(seeks.position()).toBe(60_000);
    seeks.update();
    expect(fake.sent).toHaveLength(1);
  });

  it('keeps only the latest of several seeks', () => {
    const fake = client(entry('a', 'preparing'));
    const seeks = new PendingSeek(fake);
    seeks.seek(10_000);
    seeks.seek(90_000);
    fake.set(entry('a', 'ready'));
    seeks.update();
    expect(fake.sent).toEqual([{ type: 'seek', positionMs: 90_000 }]);
  });

  it('forgets a kept seek when playback moves to another song, or the song failed', () => {
    const moved = client(entry('a', 'preparing'), 0);
    const seeks = new PendingSeek(moved);
    seeks.seek(60_000);
    moved.set(entry('b', 'ready'));
    seeks.update();
    expect(seeks.position()).toBe(0);
    moved.set(entry('a', 'ready'));
    seeks.update();
    expect(moved.sent).toEqual([]);

    const failed = client(entry('a', 'preparing'), 0);
    const failing = new PendingSeek(failed);
    failing.seek(60_000);
    failed.set(entry('a', 'failed'));
    failing.update();
    expect(failing.position()).toBe(0);
    failed.set(entry('a', 'ready'));
    failing.update();
    expect(failed.sent).toEqual([]);
  });

  it('lets a seek on the ready song replace a kept one', () => {
    const fake = client(entry('a', 'preparing'));
    const seeks = new PendingSeek(fake);
    seeks.seek(60_000);
    fake.set(entry('a', 'ready'));
    seeks.seek(5_000);
    seeks.update();
    expect(fake.sent).toEqual([{ type: 'seek', positionMs: 5_000 }]);
  });
});
