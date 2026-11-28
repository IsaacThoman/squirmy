import type { User } from '@squirmy/contracts';
import { describe, expect, it } from 'vitest';
import {
  accountKey, AccountStore, otherAccountsBytes, parseAccounts, usageLine, type AccountBackend, type LegacyAccount,
} from './accounts';
import type { Server } from './server';

const home: Server = { url: 'https://music.home', name: 'Home', version: '1.0.0', registrationRequiresInvite: true, wantlistEnabled: false };
const club: Server = { url: 'http://192.168.1.20:4747', name: 'Club', version: '1.2.0', registrationRequiresInvite: false, wantlistEnabled: true };

function user(id: string, username = id): User {
  return { id, username, displayName: null, role: 'member', canAcquire: false } as unknown as User;
}

/** The keychain and app storage, in memory. */
class FakeBackend implements AccountBackend {
  list: string | null = null;
  readonly tokens = new Map<string, string>();
  legacyAccount: LegacyAccount | null = null;
  readonly calls: string[] = [];
  async read() {
    return this.list;
  }
  async write(json: string) {
    this.list = json;
  }
  async getToken(id: string) {
    return this.tokens.get(id) ?? null;
  }
  async setToken(id: string, token: string) {
    this.tokens.set(id, token);
  }
  async removeToken(id: string) {
    this.tokens.delete(id);
  }
  async legacy() {
    return this.legacyAccount;
  }
  async removeLegacy() {
    this.calls.push('removeLegacy');
    this.legacyAccount = null;
  }
  async forgetStray() {
    this.calls.push('forgetStray');
  }
}

function store(backend = new FakeBackend(), now = { value: 1000 }) {
  let serial = 0;
  return { backend, now, store: new AccountStore(backend, { newId: () => `id-${++serial}`, now: () => now.value }) };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('AccountStore', () => {
  it('starts at Connect on a fresh install, and drops a token an earlier install left in the keychain', async () => {
    const { store: accounts, backend } = store();
    expect(await accounts.load()).toEqual({ server: null, token: null, user: null });
    expect(backend.calls).toEqual(['forgetStray']);
    expect(accounts.getSnapshot()).toEqual([]);
  });

  it('moves the single account of an earlier version into the list, token and all', async () => {
    const backend = new FakeBackend();
    backend.legacyAccount = { server: home, user: user('u1', 'ada'), token: 'secret' };
    const { store: accounts } = store(backend);
    expect(await accounts.load()).toEqual({ server: home, token: 'secret', user: user('u1', 'ada') });
    expect(backend.tokens).toEqual(new Map([['id-1', 'secret']]));
    expect(backend.calls).toEqual(['removeLegacy']);
    expect(parseAccounts(backend.list)).toEqual({
      accounts: [{ key: accountKey(home.url, 'u1'), id: 'id-1', server: home, user: user('u1', 'ada'), usedAt: 1000 }],
      current: accountKey(home.url, 'u1'),
      pending: null,
    });
    // The next launch reads the list, as the earlier record is gone.
    const again = store(backend).store;
    expect(await again.load()).toEqual({ server: home, token: 'secret', user: user('u1', 'ada') });
    expect(again.getSnapshot()).toMatchObject([{ key: accountKey(home.url, 'u1'), signedIn: true, current: true }]);
  });

  it('keeps an earlier version’s server without a session as the sign-in to open', async () => {
    const backend = new FakeBackend();
    backend.legacyAccount = { server: { ...home, registrationRequiresInvite: undefined, wantlistEnabled: undefined } as unknown as Server, user: null, token: null };
    const { store: accounts } = store(backend);
    // Servers saved before those settings were known are assumed to need an invite, and to have no wantlist.
    expect(await accounts.load()).toEqual({ server: home, token: null, user: null });
    expect(parseAccounts(backend.list)).toEqual({ accounts: [], current: null, pending: home });
  });

  it('hands back an earlier version’s token saved without its user, for the server to name', async () => {
    const backend = new FakeBackend();
    backend.legacyAccount = { server: home, user: null, token: 'old' };
    const { store: accounts } = store(backend);
    expect(await accounts.load()).toEqual({ server: home, token: 'old', user: null });
    accounts.follow({ status: 'signedIn', server: home, token: 'old', user: user('u1') });
    await settle();
    expect(backend.tokens.get('id-1')).toBe('old');
  });

  it('keeps every account signed in to, with its own token, and the one in use first', async () => {
    const { store: accounts, backend, now } = store();
    await accounts.load();
    accounts.follow({ status: 'signedIn', server: home, token: 't1', user: user('u1') });
    now.value = 2000;
    accounts.follow({ status: 'connect', previous: home });
    accounts.follow({ status: 'signIn', server: club, notice: null });
    accounts.follow({ status: 'signedIn', server: club, token: 't2', user: user('u2') });
    await settle();
    expect(backend.tokens).toEqual(new Map([['id-1', 't1'], ['id-2', 't2']]));
    expect(accounts.getSnapshot().map(({ key, signedIn, current }) => ({ key, signedIn, current }))).toEqual([
      { key: accountKey(club.url, 'u2'), signedIn: true, current: true },
      { key: accountKey(home.url, 'u1'), signedIn: true, current: false },
    ]);
    expect(accounts.token(accountKey(home.url, 'u1'))).toBe('t1');

    // Back to the first: it is the one in use, and keeps its id and token.
    now.value = 3000;
    accounts.follow({ status: 'signedIn', server: home, token: 't1', user: user('u1') });
    await settle();
    expect(accounts.getSnapshot().map(account => [account.id, account.current])).toEqual([['id-1', true], ['id-2', false]]);
    expect(parseAccounts(backend.list)!.current).toBe(accountKey(home.url, 'u1'));
  });

  it('two people on one server are two accounts', async () => {
    const { store: accounts } = store();
    await accounts.load();
    accounts.follow({ status: 'signedIn', server: home, token: 't1', user: user('u1') });
    accounts.follow({ status: 'signedIn', server: home, token: 't2', user: user('u2') });
    expect(accounts.getSnapshot().map(account => account.key)).toEqual([accountKey(home.url, 'u2'), accountKey(home.url, 'u1')]);
  });

  it('signing out drops the token and keeps the account, for signing in again', async () => {
    const { store: accounts, backend } = store();
    await accounts.load();
    const key = accountKey(home.url, 'u1');
    accounts.follow({ status: 'signedIn', server: home, token: 't1', user: user('u1') });
    accounts.signOut(key);
    accounts.follow({ status: 'signIn', server: home, notice: null });
    await settle();
    expect(backend.tokens.size).toBe(0);
    expect(accounts.getSnapshot()).toMatchObject([{ key, signedIn: false, current: false }]);
    // A relaunch opens its sign-in.
    expect(await store(backend).store.load()).toEqual({ server: home, token: null, user: null });

    // Signed in again: the same account, so what it kept on the device is its own again.
    accounts.follow({ status: 'signedIn', server: home, token: 't3', user: user('u1') });
    await settle();
    expect(backend.tokens).toEqual(new Map([['id-1', 't3']]));
  });

  it('removing an account forgets it and its token', async () => {
    const { store: accounts, backend } = store();
    await accounts.load();
    accounts.follow({ status: 'signedIn', server: home, token: 't1', user: user('u1') });
    accounts.follow({ status: 'signedIn', server: club, token: 't2', user: user('u2') });
    accounts.remove(accountKey(home.url, 'u1'));
    await settle();
    expect(backend.tokens).toEqual(new Map([['id-2', 't2']]));
    expect(parseAccounts(backend.list)!.accounts.map(account => account.key)).toEqual([accountKey(club.url, 'u2')]);
  });

  it('opens the sign-in of the account in use when the keychain lost its token', async () => {
    const backend = new FakeBackend();
    backend.list = JSON.stringify({
      accounts: [{ key: 'x', id: 'id-9', server: home, user: user('u1'), usedAt: 5 }], current: accountKey(home.url, 'u1'), pending: null,
    });
    expect(await store(backend).store.load()).toEqual({ server: home, token: null, user: null });
  });
});

describe('parseAccounts', () => {
  it('leaves out what is damaged rather than failing the launch', () => {
    expect(parseAccounts('not json')).toBeNull();
    expect(parseAccounts(JSON.stringify({ accounts: 'no' }))).toBeNull();
    expect(parseAccounts(JSON.stringify({
      accounts: [{ id: 'a', server: home, user: user('u1') }, { id: 'b', server: {}, user: user('u2') }, null], current: 'gone', pending: club,
    }))).toEqual({
      accounts: [{ key: accountKey(home.url, 'u1'), id: 'a', server: home, user: user('u1'), usedAt: 0 }], current: null, pending: club,
    });
  });
});

describe('storage lines', () => {
  it('says what an account keeps, and what the others use', () => {
    expect(usageLine({ bytes: 0, count: 0 })).toBe('None');
    expect(usageLine({ bytes: 3_500_000, count: 2 })).toMatch(/^2 songs · /);
    const usage = new Map([['a', { bytes: 10, count: 1 }], ['b', { bytes: 20, count: 2 }], ['c', { bytes: 5, count: 1 }]]);
    expect(otherAccountsBytes(usage, 'b')).toBe(15);
  });
});
