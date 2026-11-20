import { describe, expect, it, vi } from 'vitest';
import { Keychain, type SecureStore } from './keychain';

const entitlementError = () => new Error('Calling the \'setValueWithKeyAsync\' function has failed → Caused by: A required entitlement is not present.');

function workingStore(): SecureStore & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItemAsync: async key => items.get(key) ?? null,
    setItemAsync: async (key, value) => { items.set(key, value); },
    deleteItemAsync: async key => { items.delete(key); },
  };
}

/** A keychain that refuses everything, as on a simulator build without the keychain entitlement. */
const refusingStore: SecureStore = {
  getItemAsync: () => Promise.reject(entitlementError()),
  setItemAsync: () => Promise.reject(entitlementError()),
  deleteItemAsync: () => Promise.reject(entitlementError()),
};

describe('Keychain', () => {
  it('reads and writes through a working keychain', async () => {
    const store = workingStore();
    const keychain = new Keychain(store);
    await keychain.set('token', 'abc');
    expect(store.items.get('token')).toBe('abc');
    expect(await new Keychain(store).get('token')).toBe('abc');
    await keychain.remove('token');
    expect(await new Keychain(store).get('token')).toBeNull();
    expect(keychain.refused).toBe(false);
  });

  it('keeps refused writes in memory for this launch without rejecting', async () => {
    const keychain = new Keychain(refusingStore);
    await expect(keychain.set('token', 'abc')).resolves.toBeUndefined();
    expect(await keychain.get('token')).toBe('abc');
    await expect(keychain.remove('token')).resolves.toBeUndefined();
    expect(await keychain.get('token')).toBeNull();
    expect(keychain.refused).toBe(true);
  });

  it('answers a refused read with nothing', async () => {
    const keychain = new Keychain(refusingStore);
    await expect(keychain.get('device')).resolves.toBeNull();
    expect(keychain.refused).toBe(true);
  });

  it('tells its listeners once, however often the keychain refuses', async () => {
    const keychain = new Keychain(refusingStore);
    const listener = vi.fn();
    const stop = keychain.onRefused(listener);
    await keychain.get('token');
    await keychain.set('token', 'abc');
    await keychain.set('device', 'id-1');
    expect(listener).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps a value whose write failed even when a later read works', async () => {
    const store = workingStore();
    let refuse = true;
    const keychain = new Keychain({
      ...store,
      setItemAsync: (key, value) => refuse ? Promise.reject(entitlementError()) : store.setItemAsync(key, value),
    });
    await keychain.set('device', 'id-1');
    refuse = false;
    expect(await keychain.get('device')).toBe('id-1');
  });
});
