import { createInitialSession, splitSession, type SessionOutage } from '@squirmy/client-core';
import type { EntryFailure, QueueEntry } from '@squirmy/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createNoticeReporter } from './playbackNotices';

const entry = (n: number, state: QueueEntry['state'] = 'preparing'): QueueEntry => ({ id: `e.${n}`, trackId: `t.${n}`, albumId: null, durationMs: 1000, state });

type Shape = { current?: QueueEntry | null; queue?: QueueEntry[]; playing?: boolean; outage?: SessionOutage | null };

function snapshot({ current = null, queue = [], playing = true, outage = null }: Shape) {
  const { state, queue: half } = splitSession({ ...createInitialSession(), current, queue, playing });
  return { session: state, queue: half, connection: 'online' as const, outage };
}

function reporter(failures: Record<string, EntryFailure> = {}) {
  const status = { report: vi.fn(), resume: vi.fn() };
  const notices = createNoticeReporter({ failureOf: trackId => failures[trackId], titleOf: trackId => `Song ${trackId.slice(2)}`, status });
  return { status, update: (shape: Shape) => notices(snapshot(shape)) };
}

describe('createNoticeReporter', () => {
  it('says a picked song that couldn’t play couldn’t play, not that it was skipped, and keeps saying it', () => {
    const { status, update } = reporter({ 't.1': 'unavailable' });
    update({ current: entry(1), queue: [entry(2)], playing: true });
    update({ current: entry(1, 'failed'), queue: [entry(2)], playing: false });
    expect(status.report).toHaveBeenCalledTimes(1);
    expect(status.report).toHaveBeenCalledWith({ message: 'Couldn’t play “Song 1”', detail: 'It isn’t available.' }, { lasting: true });
  });

  it('tells a skipped song for a few seconds', () => {
    const { status, update } = reporter({ 't.1': 'error' });
    update({ current: entry(1), queue: [entry(2)] });
    update({ current: entry(2) });
    expect(status.report).toHaveBeenCalledWith({ message: 'Couldn’t play “Song 1”', detail: 'Skipped.' });
  });

  it('lets go of a held song’s notice when playback moves to another song, though it stays paused', () => {
    const { status, update } = reporter({ 't.1': 'error' });
    update({ current: entry(1), queue: [entry(2)] });
    update({ current: entry(1, 'failed'), queue: [entry(2)], playing: false });
    status.resume.mockClear();
    update({ current: entry(1, 'failed'), queue: [entry(2)], playing: false });
    expect(status.resume).not.toHaveBeenCalled();
    update({ current: entry(2), playing: false });
    expect(status.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps a stop’s notice until playback resumes', () => {
    const { status, update } = reporter();
    update({ current: entry(1), queue: [entry(2)] });
    update({ current: entry(1, 'failed'), queue: [entry(2)], playing: false, outage: { kind: 'outage', reason: null, trackId: 't.1' } });
    expect(status.report).toHaveBeenCalledWith({ message: 'Can’t load music right now', detail: 'Playback is paused.' }, { lasting: true });
    status.resume.mockClear();
    update({ current: entry(1, 'failed'), queue: [entry(2)], playing: true, outage: { kind: 'outage', reason: null, trackId: 't.1' } });
    expect(status.resume).toHaveBeenCalled();
  });
});
