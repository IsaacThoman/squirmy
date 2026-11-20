/** The parts of `expo-secure-store` the app uses, so tests can hand in one that refuses. */
export type SecureStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

/**
 * The keychain, for secrets that should outlive this launch. When it refuses a read or a
 * write (a build without the keychain entitlement, a locked device), the value is kept in
 * memory, so the app works until it quits. Nothing here rejects. `refused` turns true
 * the first time the keychain fails, and the listeners hear about it once.
 */
export class Keychain {
  private readonly memory = new Map<string, string | null>();
  private readonly listeners = new Set<() => void>();
  refused = false;

  constructor(private readonly store: SecureStore) {}

  async get(key: string): Promise<string | null> {
    if (this.memory.has(key)) return this.memory.get(key) ?? null;
    try {
      return await this.store.getItemAsync(key);
    } catch {
      this.refuse();
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.memory.set(key, value);
    try {
      await this.store.setItemAsync(key, value);
    } catch {
      this.refuse();
    }
  }

  async remove(key: string): Promise<void> {
    this.memory.set(key, null);
    try {
      await this.store.deleteItemAsync(key);
    } catch {
      this.refuse();
    }
  }

  /** Calls `listener` when the keychain first refuses. Returns the unsubscribe. */
  onRefused(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private refuse() {
    if (this.refused) return;
    this.refused = true;
    for (const listener of this.listeners) listener();
  }
}
