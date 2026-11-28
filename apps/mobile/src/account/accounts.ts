import { formatBytes, plural } from '@squirmy/client-core';
import type { User } from '@squirmy/contracts';
import type { AuthState } from './auth';
import type { Server } from './server';

/**
 * Everything the app keeps for an account (its downloads, streaming cache, saved library,
 * hearts waiting to be sent and playback session) is filed under its server and user.
 */
export function accountKey(serverUrl: string, userId: string): string {
  return `${serverUrl}|${userId}`;
}

/** An account this device has signed in to. Its token is kept apart, in the keychain. */
export type SavedAccount = {
  /** `accountKey(server.url, user.id)`. */
  key: string;
  /** Names its token in the keychain, whose keys take only letters, digits, dots, dashes and underscores. */
  id: string;
  server: Server;
  user: User;
  /** When it was last the account in use, so the switcher lists the most recent first. */
  usedAt: number;
};

export type SavedAccounts = {
  accounts: SavedAccount[];
  /** The account in use; null at Connect and at sign-in. */
  current: string | null;
  /** The server chosen at Connect and not signed in to yet: a relaunch opens its sign-in. */
  pending: Server | null;
};

export const noAccounts: SavedAccounts = { accounts: [], current: null, pending: null };

/** The one account earlier versions kept. */
export type LegacyAccount = { server: Server; user: User | null; token: string | null };

/** What a launch opens with: the server, and the session when there is one. */
export type StoredSession = { server: Server | null; token: string | null; user: User | null };

/** A saved account as the switcher shows it. */
export type AccountChoice = SavedAccount & { signedIn: boolean; current: boolean };

/** Servers saved before a setting was known: an invite is assumed to be required, and the wantlist off. */
export function normalizeServer(server: Server): Server {
  return {
    ...server,
    registrationRequiresInvite: server.registrationRequiresInvite ?? true,
    wantlistEnabled: server.wantlistEnabled ?? false,
  };
}

/** The saved list from its JSON. Anything damaged is left out rather than failing the launch. */
export function parseAccounts(json: string | null): SavedAccounts | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as Partial<SavedAccounts>;
    if (!value || !Array.isArray(value.accounts)) return null;
    const accounts = value.accounts.filter((account): account is SavedAccount => Boolean(
      account?.id && account.server?.url && account.user?.id,
    )).map(account => ({
      ...account,
      key: accountKey(account.server.url, account.user.id),
      server: normalizeServer(account.server),
      usedAt: account.usedAt ?? 0,
    }));
    const current = accounts.some(account => account.key === value.current) ? value.current! : null;
    const pending = !current && value.pending?.url ? normalizeServer(value.pending) : null;
    return { accounts, current, pending };
  } catch {
    return null;
  }
}

/**
 * The account for `server` and `user` added or brought up to date, and made the one in use.
 * An account signed in to again keeps its id, so its token replaces the old one.
 */
export function withAccount(saved: SavedAccounts, server: Server, user: User, now: number, newId: () => string): { saved: SavedAccounts; account: SavedAccount } {
  const key = accountKey(server.url, user.id);
  const existing = saved.accounts.find(account => account.key === key);
  const usedAt = existing && saved.current === key ? existing.usedAt : now;
  const account: SavedAccount = { key, id: existing?.id ?? newId(), server, user, usedAt };
  return {
    saved: { accounts: [account, ...saved.accounts.filter(other => other.key !== key)], current: key, pending: null },
    account,
  };
}

/** No account in use: at Connect (`pending` null) or signing in to `pending`. The saved accounts stay. */
export function withPending(saved: SavedAccounts, pending: Server | null): SavedAccounts {
  return { ...saved, current: null, pending };
}

export function withoutAccount(saved: SavedAccounts, key: string): SavedAccounts {
  return {
    accounts: saved.accounts.filter(account => account.key !== key),
    current: saved.current === key ? null : saved.current,
    pending: saved.pending,
  };
}

/** The account in use first, then the others, the most recently used first. */
export function orderedAccounts(saved: SavedAccounts): SavedAccount[] {
  return [...saved.accounts].sort((a, b) => Number(b.key === saved.current) - Number(a.key === saved.current) || b.usedAt - a.usedAt);
}

/** The session a launch opens with. */
export function sessionOf(saved: SavedAccounts, token: (key: string) => string | null): StoredSession {
  const current = saved.accounts.find(account => account.key === saved.current);
  if (current) {
    const currentToken = token(current.key);
    // A token the keychain lost: the account's sign-in opens, and its downloads wait for it.
    return currentToken ? { server: current.server, token: currentToken, user: current.user } : { server: current.server, token: null, user: null };
  }
  return { server: saved.pending, token: null, user: null };
}

/** What an account keeps on the device, in downloads or the streaming cache. */
export type Usage = { bytes: number; count: number };

/** `12 songs · 48 MB`, or `None`. */
export function usageLine({ bytes, count }: Usage): string {
  return count ? `${plural(count, 'song')} · ${formatBytes(bytes)}` : 'None';
}

/** What the accounts other than `current` use, for a storage limit that is the device's. */
export function otherAccountsBytes(usage: ReadonlyMap<string, Usage>, current: string): number {
  let bytes = 0;
  for (const [key, value] of usage) if (key !== current) bytes += value.bytes;
  return bytes;
}

/** Where the saved list and the tokens are kept. Nothing here rejects. */
export type AccountBackend = {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
  getToken(id: string): Promise<string | null>;
  setToken(id: string, token: string): Promise<void>;
  removeToken(id: string): Promise<void>;
  /** The account an earlier version kept, if it is still there. */
  legacy(): Promise<LegacyAccount | null>;
  /** Removes it, once the saved list has it. Kept when the keychain refused, so nothing is lost. */
  removeLegacy(): Promise<void>;
  /** On a fresh install: a token the keychain kept from an earlier install of the app. */
  forgetStray(): Promise<void>;
};

/**
 * The accounts this device has signed in to, and which one is in use. `follow` keeps it in
 * step with the auth state; tokens are read once at launch and kept in memory.
 */
export class AccountStore {
  private saved: SavedAccounts = noAccounts;
  private readonly tokens = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private snapshot: AccountChoice[] = [];
  private writing: Promise<void> = Promise.resolve();
  private written = '';

  constructor(private readonly backend: AccountBackend, private readonly options: { newId: () => string; now?: () => number }) {}

  private get now() {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Reads the saved accounts, moving an earlier version's single account into the list.
   * A legacy session saved without its user comes back with `user` null, for the caller to
   * ask the server who it is.
   */
  async load(): Promise<StoredSession> {
    const saved = parseAccounts(await this.backend.read());
    if (saved) {
      this.saved = saved;
      await Promise.all(saved.accounts.map(async account => {
        const token = await this.backend.getToken(account.id);
        if (token) this.tokens.set(account.key, token);
      }));
      this.changed();
      return sessionOf(saved, key => this.tokens.get(key) ?? null);
    }
    const legacy = await this.backend.legacy();
    if (!legacy) {
      await this.backend.forgetStray();
      return { server: null, token: null, user: null };
    }
    const server = normalizeServer(legacy.server);
    if (legacy.user && legacy.token) {
      const { saved: next, account } = withAccount(noAccounts, server, legacy.user, this.now, this.options.newId);
      this.saved = next;
      this.tokens.set(account.key, legacy.token);
      await this.backend.setToken(account.id, legacy.token);
    } else {
      this.saved = withPending(noAccounts, server);
    }
    await this.persist();
    await this.backend.removeLegacy();
    this.changed();
    return { server, token: legacy.token, user: legacy.user && legacy.token ? legacy.user : null };
  }

  /** Records what the auth state says: the account in use, or the server being signed in to. */
  follow(state: AuthState): void {
    if (state.status === 'restoring') return;
    if (state.status === 'connect') this.saved = withPending(this.saved, null);
    else if (state.status === 'signIn') this.saved = withPending(this.saved, state.server);
    else {
      const { saved, account } = withAccount(this.saved, state.server, state.user, this.now, this.options.newId);
      this.saved = saved;
      if (this.tokens.get(account.key) !== state.token) {
        this.tokens.set(account.key, state.token);
        this.queue(() => this.backend.setToken(account.id, state.token));
      }
    }
    void this.persist();
    this.changed();
  }

  /** The token of a saved account, if it is still signed in. */
  token(key: string): string | null {
    return this.tokens.get(key) ?? null;
  }

  account(key: string): SavedAccount | undefined {
    return this.saved.accounts.find(account => account.key === key);
  }

  /** Signs the account out on this device: its token goes, the account and what it kept stay. */
  signOut(key: string): void {
    const account = this.account(key);
    this.tokens.delete(key);
    if (account) this.queue(() => this.backend.removeToken(account.id));
    this.changed();
  }

  /** Forgets the account altogether. What it kept on the device is removed by the caller. */
  remove(key: string): void {
    const account = this.account(key);
    this.tokens.delete(key);
    this.saved = withoutAccount(this.saved, key);
    if (account) this.queue(() => this.backend.removeToken(account.id));
    void this.persist();
    this.changed();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** The saved accounts, the one in use first. A new array only when something changed. */
  getSnapshot = (): AccountChoice[] => this.snapshot;

  /** Writes run one after another, in the order they were made. */
  private queue(write: () => Promise<void>): Promise<void> {
    this.writing = this.writing.then(write, write);
    return this.writing;
  }

  private persist(): Promise<void> {
    const json = JSON.stringify(this.saved);
    if (json === this.written) return this.writing;
    this.written = json;
    return this.queue(() => this.backend.write(json));
  }

  private changed(): void {
    const next = orderedAccounts(this.saved).map(account => ({
      ...account, signedIn: this.tokens.has(account.key), current: account.key === this.saved.current,
    }));
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
