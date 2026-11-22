import { ApiError } from '@squirmy/client-core';
import { describe, expect, it, vi } from 'vitest';
import { LikeQueue, refusedNotice, type QueuedLike } from './likeQueue';

function memory(initial: QueuedLike[] = []) {
  let saved = initial;
  return { load: () => saved, save: (likes: readonly QueuedLike[]) => { saved = [...likes]; }, get saved() { return saved; } };
}

const offline = (_like: QueuedLike) => Promise.reject(new ApiError(0, 'network_error', 'Network request failed'));

describe('LikeQueue', () => {
  it('keeps likes made offline, in storage, and sends them in order on reconnect', async () => {
    const storage = memory();
    const send = vi.fn(offline);
    const queue = new LikeQueue(storage, like => send(like));
    queue.add({ type: 'track', id: 'a', liked: true });
    queue.add({ type: 'album', id: 'b', liked: true });
    expect(await queue.flush()).toEqual({ applied: [], refused: [] });
    expect(send).toHaveBeenCalledOnce();
    expect(storage.saved).toHaveLength(2);

    const relaunched = new LikeQueue(storage, async () => undefined);
    expect(relaunched.pending).toHaveLength(2);
    expect((await relaunched.flush()).applied.map(like => like.id)).toEqual(['a', 'b']);
    expect(storage.saved).toEqual([]);
  });

  it('sends only the last change to the same item', async () => {
    const send = vi.fn(async (_like: QueuedLike) => undefined);
    const queue = new LikeQueue(memory(), send);
    queue.add({ type: 'track', id: 'a', liked: true });
    queue.add({ type: 'track', id: 'a', liked: false });
    queue.add({ type: 'artist', id: 'a', liked: true });
    await queue.flush();
    expect(send.mock.calls.map(([like]) => like)).toEqual([{ type: 'track', id: 'a', liked: false }, { type: 'artist', id: 'a', liked: true }]);
  });

  it('drops and reports what the server refuses, and retries server errors', async () => {
    const send = vi.fn(async (like: QueuedLike) => {
      if (like.id === 'gone') throw new ApiError(404, 'not_found', 'No such track');
      if (like.id === 'busy') throw new ApiError(503, 'unavailable', 'Try later');
    });
    const queue = new LikeQueue(memory(), send);
    queue.add({ type: 'track', id: 'gone', liked: true });
    queue.add({ type: 'track', id: 'busy', liked: true });
    const result = await queue.flush();
    expect(result.refused.map(like => like.id)).toEqual(['gone']);
    expect(queue.pending.map(like => like.id)).toEqual(['busy']);
  });

  it('keeps a change made while the previous one for the same item was being sent', async () => {
    let release!: () => void;
    const send = vi.fn((_like: QueuedLike) => new Promise<void>(resolve => { release = resolve; }));
    const queue = new LikeQueue(memory(), send);
    queue.add({ type: 'track', id: 'a', liked: true });
    const first = queue.flush();
    await Promise.resolve();
    queue.add({ type: 'track', id: 'a', liked: false });
    const second = queue.flush();
    release();
    await first;
    await Promise.resolve();
    release();
    await second;
    expect(send.mock.calls.map(([like]) => like.liked)).toEqual([true, false]);
    expect(queue.pending).toEqual([]);
  });

  it('restores a removed save with the time the removal answered', async () => {
    const send = vi.fn(async (like: QueuedLike, _savedAt: string | undefined) => like.liked ? undefined : { savedAt: '2026-01-02T03:04:05.000Z' });
    const queue = new LikeQueue(memory(), send);
    queue.add({ type: 'album', id: 'a', liked: false });
    await queue.flush();
    queue.add({ type: 'album', id: 'a', liked: true, restore: true });
    await queue.flush();
    expect(send.mock.calls[1]).toEqual([{ type: 'album', id: 'a', liked: true, restore: true }, '2026-01-02T03:04:05.000Z']);
    // A save that is not an Undo is new, so it goes to the top.
    queue.add({ type: 'album', id: 'a', liked: true });
    await queue.flush();
    expect(send.mock.calls[2]![1]).toBeUndefined();
  });

  it('finds the time for an Undo made while the removal was on its way', async () => {
    let answer!: (value: { savedAt: string }) => void;
    const send = vi.fn((like: QueuedLike, _savedAt: string | undefined) => like.liked
      ? Promise.resolve()
      : new Promise<{ savedAt: string }>(resolve => { answer = resolve; }));
    const queue = new LikeQueue(memory(), send);
    queue.add({ type: 'track', id: 't', liked: false });
    const removal = queue.flush();
    await Promise.resolve();
    queue.add({ type: 'track', id: 't', liked: true, restore: true });
    const undo = queue.flush();
    answer({ savedAt: '2026-01-02T03:04:05.000Z' });
    await Promise.all([removal, undo]);
    expect(send.mock.calls.map(([like, savedAt]) => [like.liked, savedAt])).toEqual([[false, undefined], [true, '2026-01-02T03:04:05.000Z']]);
  });

  it('sends an Undo of a removal still queued offline as a plain save, in its place', async () => {
    const storage = memory();
    const queue = new LikeQueue(storage, offline);
    queue.add({ type: 'album', id: 'a', liked: false });
    await queue.flush();
    queue.add({ type: 'album', id: 'a', liked: true, restore: true });
    const send = vi.fn(async (_like: QueuedLike, _savedAt: string | undefined) => undefined);
    await new LikeQueue(storage, send).flush();
    expect(send.mock.calls).toEqual([[{ type: 'album', id: 'a', liked: true, restore: true }, undefined]]);
  });

  it('reports a refusal with what it was, so Try again can send it again', async () => {
    const queue = new LikeQueue(memory(), () => Promise.reject(new ApiError(403, 'forbidden', 'No')));
    const like = { type: 'album', id: 'a', liked: false, title: 'Kid A', restore: undefined } as const;
    queue.add(like);
    expect((await queue.flush()).refused).toEqual([like]);
    expect(refusedNotice(true)).toBe('Couldn’t save to your library.');
    expect(refusedNotice(false)).toBe('Couldn’t remove from your library.');
  });
});
