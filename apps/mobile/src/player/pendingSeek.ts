import type { SessionClientSnapshot } from '@squirmy/client-core';
import type { SessionCommand } from '@squirmy/contracts';

/** The parts of the session client a pending seek reads and drives. */
export type SeekClient = {
  getSnapshot: () => Pick<SessionClientSnapshot, 'session'>;
  getPositionMs: () => number;
  dispatch: (command: SessionCommand) => void;
};

/**
 * Seeks the current song, or, while the server is still fetching it, keeps the seek and sends
 * it once the song is ready, as the web player does (`Listening`). The session ignores a seek
 * until then, since nothing knows the song's length for certain, so sent at once the bar would
 * jump back. Until it is sent, the position shown is where the seek asked for.
 */
export class PendingSeek {
  private pending: { entryId: string; positionMs: number } | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly client: SeekClient) {}

  seek(positionMs: number): void {
    const current = this.client.getSnapshot().session.current;
    if (current?.state === 'preparing') {
      this.pending = { entryId: current.id, positionMs };
      this.emit();
      return;
    }
    const had = this.pending !== null;
    this.pending = null;
    this.client.dispatch({ type: 'seek', positionMs });
    if (had) this.emit();
  }

  /** Call after each session change: sends a kept seek once its song is ready, and forgets it when the song changed or failed. */
  update(): void {
    const pending = this.pending;
    if (!pending) return;
    const current = this.client.getSnapshot().session.current;
    if (pending.entryId !== current?.id || current.state === 'failed') return this.drop();
    if (current.state !== 'ready') return;
    // Sent before the position is read again, so it reads where the seek landed.
    this.pending = null;
    this.client.dispatch({ type: 'seek', positionMs: pending.positionMs });
    this.emit();
  }

  /** The position to show: a kept seek's, otherwise the session's. */
  position(): number {
    const pending = this.pending;
    if (pending && pending.entryId === this.client.getSnapshot().session.current?.id) return pending.positionMs;
    return this.client.getPositionMs();
  }

  /** Called when a seek is kept or let go, which moves the position without a session change. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private drop() {
    if (!this.pending) return;
    this.pending = null;
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}
