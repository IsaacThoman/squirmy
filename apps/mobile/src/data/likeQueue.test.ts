import { ApiError } from '@squirmy/client-core';
import { describe, expect, it, vi } from 'vitest';
import { isUnsent, LikeQueue, likeRetryDelay, likeRetryDelaysMs, type QueuedLike } from './likeQueue';

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

  it('drops and reports what the server refuses, a 500 included, and keeps what a gateway answered', async () => {
    const send = vi.fn(async (like: QueuedLike) => {
      if (like.id === 'gone') throw new ApiError(404, 'not_found', 'No such track');
      if (like.id === 'broken') throw new ApiError(500, 'internal', 'Something broke');
      if (like.id === 'down') throw new ApiError(502, 'bad_gateway', 'Bad gateway');
    });
    const queue = new LikeQueue(memory(), send);
    queue.add({ type: 'track', id: 'gone', liked: true });
    queue.add({ type: 'track', id: 'broken', liked: true });
    queue.add({ type: 'track', id: 'down', liked: true });
    const result = await queue.flush();
    expect(result.refused.map(like => like.id)).toEqual(['gone', 'broken']);
    expect(queue.pending.map(like => like.id)).toEqual(['down']);
  });

  it('counts as unsent only what never reached the server', () => {
    expect(isUnsent(new ApiError(0, 'network_error', 'Network request failed'))).toBe(true);
    expect(isUnsent(new TypeError('Network request failed'))).toBe(true);
    for (const status of [502, 503, 504]) expect(isUnsent(new ApiError(status, 'unavailable', 'Gateway'))).toBe(true);
    for (const status of [400, 403, 404, 500, 501]) expect(isUnsent(new ApiError(status, 'error', 'No'))).toBe(false);
  });

  it('tries a few times, waiting longer each time, then gives up', () => {
    expect(likeRetryDelaysMs.map((_delay, index) => likeRetryDelay(index + 1))).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    expect(likeRetryDelay(likeRetryDelaysMs.length + 1)).toBeNull();
  });

  it('gives up on everything waiting, in storage too, and returns it for the hearts to go back', async () => {
    const storage = memory();
    const queue = new LikeQueue(storage, offline);
    queue.add({ type: 'track', id: 'a', liked: true, inLibrary: false });
    queue.add({ type: 'album', id: 'b', liked: false });
    await queue.flush();
    expect(queue.giveUp().map(like => like.id)).toEqual(['a', 'b']);
    expect(queue.pending).toEqual([]);
    expect(storage.saved).toEqual([]);
  });

  it('keeps the library mark from before the first change to an item, for a refusal to put back', () => {
    const queue = new LikeQueue(memory(), offline);
    queue.add({ type: 'track', id: 'a', liked: true, inLibrary: false });
    queue.add({ type: 'track', id: 'a', liked: false, inLibrary: true });
    queue.add({ type: 'track', id: 'a', liked: true, inLibrary: true });
    expect(queue.pending).toEqual([{ type: 'track', id: 'a', liked: true, inLibrary: false }]);
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

  it('reports a refusal with what it was, so the heart can show it and a tap can send it again', async () => {
    const queue = new LikeQueue(memory(), () => Promise.reject(new ApiError(403, 'forbidden', 'No')));
    const like = { type: 'album', id: 'a', liked: false, title: 'Kid A' } as const;
    queue.add(like);
    expect((await queue.flush()).refused).toEqual([like]);
  });
});
