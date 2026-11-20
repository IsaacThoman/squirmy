import { ApiError } from '@squirmy/client-core';
import type { LikeEntityType } from '@squirmy/contracts';

export type QueuedLike = { type: LikeEntityType; id: string; liked: boolean };

export type LikeQueueStorage = { load(): QueuedLike[]; save(likes: readonly QueuedLike[]): void };

export type FlushResult = { applied: QueuedLike[]; refused: QueuedLike[] };

/** The server never got the request; it can be sent again later. Any other failure is the server saying no. */
export function isUnsent(error: unknown): boolean {
  return !(error instanceof ApiError) || error.code === 'network_error' || error.status >= 500;
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

  constructor(private readonly storage: LikeQueueStorage, private readonly send: (like: QueuedLike) => Promise<void>) {
    this.items = storage.load();
  }

  get pending(): readonly QueuedLike[] {
    return this.items;
  }

  add(like: QueuedLike): void {
    this.items = [...this.items.filter(item => !sameTarget(item, like)), like];
    this.storage.save(this.items);
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
