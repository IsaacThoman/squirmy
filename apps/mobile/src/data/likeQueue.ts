import { ApiError } from '@squirmy/client-core';
import type { LikeEntityType } from '@squirmy/contracts';

/**
 * A heart or its removal. `title` names the item in a notice. `restore` marks the Undo of a
 * removal: it is sent with the time the removed save had been made, so the item goes back
 * to its place in Recently added and Liked Songs instead of the top.
 */
export type QueuedLike = { type: LikeEntityType; id: string; liked: boolean; title?: string; restore?: boolean };

/** What sending a like answers: a removal says when the save it removed had been made. */
export type LikeAnswer = { savedAt: string | null } | void;

export type LikeQueueStorage = { load(): QueuedLike[]; save(likes: readonly QueuedLike[]): void };

export type FlushResult = { applied: QueuedLike[]; refused: QueuedLike[] };

/** The server never got the request; it can be sent again later. Any other failure is the server saying no. */
export function isUnsent(error: unknown): boolean {
  return !(error instanceof ApiError) || error.code === 'network_error' || error.status >= 500;
}

/** What a heart the server refused says, in place of the notice that confirmed it; its Try again sends the same change again. */
export function refusedNotice(liked: boolean): string {
  return liked ? 'Couldn’t save to your library.' : 'Couldn’t remove from your library.';
}

const sameTarget = (a: QueuedLike, b: QueuedLike) => a.type === b.type && a.id === b.id;
const keyOf = (like: QueuedLike) => `${like.type}:${like.id}`;

/**
 * Likes and unlikes waiting for the server, kept in storage so they survive a relaunch.
 * Changing the same item again replaces its entry: only the last word is sent. `flush`
 * sends them in order and stops at the first that cannot reach the server, keeping it
 * and the rest for the next try.
 *
 * A removal the server took answers when the save had been made; a `restore` sent after it
 * passes that time back. One that never reached the server (an Undo while offline replaces
 * it) has no answer, and the restore is a plain save.
 */
export class LikeQueue {
  private items: QueuedLike[];
  private flushing: Promise<FlushResult> | null = null;
  /** When each save removed here had been made, from the server's answers; kept in memory only. */
  private readonly removedSaves = new Map<string, string>();

  constructor(
    private readonly storage: LikeQueueStorage,
    private readonly send: (like: QueuedLike, savedAt: string | undefined) => Promise<LikeAnswer>,
  ) {
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
        // Read when the like is sent, so an Undo made while its removal was on the way still finds the time.
        const savedAt = like.liked && like.restore ? this.removedSaves.get(keyOf(like)) : undefined;
        const answer = await this.send(like, savedAt);
        if (!like.liked && answer?.savedAt) this.removedSaves.set(keyOf(like), answer.savedAt);
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
