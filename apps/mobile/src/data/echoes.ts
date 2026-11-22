/**
 * Changes this device made, so their `invalidate` echo (the server sends a user's keys to
 * all of their devices, the one that made the change too) can be told from another
 * device's change. Each expected key is matched once, within `windowMs` of the request.
 */
export class Echoes {
  private readonly expected = new Map<string, number[]>();

  constructor(private readonly windowMs = 15_000, private readonly now: () => number = Date.now) {}

  /** A request that will make the server invalidate `key` is on its way. Bound, so it can be passed around. */
  expect = (key: readonly unknown[]): void => {
    const hash = JSON.stringify(key);
    this.expected.set(hash, [...this.live(hash), this.now() + this.windowMs]);
  };

  /** True when `keys` is the echo of a change made here; that expectation is used up. */
  isOwn(keys: readonly (readonly unknown[])[]): boolean {
    for (const key of keys) {
      const hash = JSON.stringify(key);
      const [first, ...rest] = this.live(hash);
      if (first === undefined) continue;
      if (rest.length) this.expected.set(hash, rest);
      else this.expected.delete(hash);
      return true;
    }
    return false;
  }

  private live(hash: string): number[] {
    const now = this.now();
    return (this.expected.get(hash) ?? []).filter(until => until > now);
  }
}
