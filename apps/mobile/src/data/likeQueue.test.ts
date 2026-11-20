import { ApiError } from '@squirmy/client-core';
import { describe, expect, it, vi } from 'vitest';
import { LikeQueue, type QueuedLike } from './likeQueue';

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
});
