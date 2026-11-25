import { ApiError } from '@squirmy/client-core';
import type { LikeEntityType } from '@squirmy/contracts';
import { isGatewayStatus } from './reachability';

/**
 * A heart or its removal. `title` names the item where a refusal is shown. `inLibrary` is
 * what the item's library mark was before this device changed it, for a refusal to put back.
 */
export type QueuedLike = { type: LikeEntityType; id: string; liked: boolean; title?: string; inLibrary?: boolean };

export type LikeQueueStorage = { load(): QueuedLike[]; save(likes: readonly QueuedLike[]): void };

export type FlushResult = { applied: QueuedLike[]; refused: QueuedLike[] };

/**
 * The server never got the request, so it can be sent again later: no answer at all, or a
 * gateway's (a proxy in front of a server that is down, as `HttpReach` counts it). Any other
 * answer is the server's, a 500 included: it says no, and the heart goes back.
 */
export function isUnsent(error: unknown): boolean {
  return !(error instanceof ApiError) || error.code === 'network_error' || isGatewayStatus(error.status);
}

/**
 * How long to wait before sending again what could not reach the server while the app is
 * online, by how many tries have failed so far; null once it is time to give up. Offline,
 * the queue waits for the reconnect instead and these tries do not count.
 */
export const likeRetryDelaysMs = [15_000, 30_000, 60_000, 2 * 60_000, 4 * 60_000] as const;

export function likeRetryDelay(failedTries: number): number | null {
  return likeRetryDelaysMs[failedTries - 1] ?? null;
}

const sameTarget = (a: QueuedLike, b: QueuedLike) => a.type === b.type && a.id === b.id;

/**
 * Likes and unlikes waiting for the server, kept in storage so they survive a relaunch.
 * Changing the same item again replaces its entry: only the last word is sent. `flush`
 * sends them in order and stops at the first that cannot reach the server, keeping it
 * and the rest for the next try.
 */
export class LikeQueue {
  private items: QueuedLike[];
  private flushing: Promise<FlushResult> | null = null;

  constructor(
    private readonly storage: LikeQueueStorage,
    private readonly send: (like: QueuedLike) => Promise<unknown>,
  ) {
    this.items = storage.load();
  }

  get pending(): readonly QueuedLike[] {
    return this.items;
  }

  /** Queues `like`, in place of a change to the same item still waiting, whose `inLibrary` it keeps. */
  add(like: QueuedLike): void {
    const earlier = this.items.find(item => sameTarget(item, like));
    const queued = earlier?.inLibrary !== undefined ? { ...like, inLibrary: earlier.inLibrary } : like;
    this.items = [...this.items.filter(item => item !== earlier), queued];
    this.storage.save(this.items);
  }

  /** Drops everything waiting and returns it, for the hearts to go back: the server could not be reached for too long. */
  giveUp(): QueuedLike[] {
    const dropped = this.items;
    this.items = [];
    this.storage.save(this.items);
    return dropped;
  }

  /** Sends what is waiting. Calls made during a flush wait for it and then flush again. */
  async flush(): Promise<FlushResult> {
    while (this.flushing) await this.flushing;
    this.flushing = this.run().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async run(): Promise<FlushResult> {
    const result: FlushResult = { applied: [], refused: [] };
    for (const like of [...this.items]) {
      try {
        await this.send(like);
        result.applied.push(like);
      } catch (error) {
        if (isUnsent(error)) break;
        result.refused.push(like);
      }
      // A newer change to the same item, made while this one was sent, stays queued.
      this.items = this.items.filter(item => item !== like);
      this.storage.save(this.items);
    }
    return result;
  }
}
