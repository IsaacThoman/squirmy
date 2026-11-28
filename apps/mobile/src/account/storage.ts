import 'expo-sqlite/localStorage/install';

import type { ClientDevice } from '@squirmy/contracts';
import { uuid } from 'expo';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { AccountStore, type AccountBackend, type LegacyAccount } from './accounts';
import { Keychain } from './keychain';

const listKey = 'squirmy.accounts.v1';
/** The phone's one account before there were several: the server and user, and the token beside them. */
const legacyKey = 'squirmy.account.v1';
const legacyTokenKey = 'squirmy.token';
const deviceKey = 'squirmy.device-id';
const tvListKey = 'squirmy.tv.accounts.v1';
const tvLegacyKey = 'squirmy.tv.account.v1';
// Readable while the phone is locked, so background playback can keep talking to the server.
const access = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/** Holds the tokens and the device id. When it refuses, they last only until the app quits. */
export const keychain = new Keychain({
  getItemAsync: key => SecureStore.getItemAsync(key, access),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, access),
  deleteItemAsync: key => SecureStore.deleteItemAsync(key, access),
});

function readLocal(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // The app still works for this launch; the next one starts at Connect.
  }
}

function parseLegacy(json: string | null): LegacyAccount | null {
  try {
    const saved = json ? JSON.parse(json) as Partial<LegacyAccount> : null;
    return saved?.server?.url ? { server: saved.server, user: saved.user ?? null, token: saved.token ?? null } : null;
  } catch {
    // A damaged record is treated as a fresh connection.
    return null;
  }
}

/**
 * On the phone the list of accounts is not secret and lives in app storage, which an
 * uninstall removes; each token is in the keychain. On Apple TV, tvOS may purge app
 * storage, so the list lives in the keychain too.
 */
function accountBackend(): AccountBackend {
  const tokenKey = (id: string) => `${Platform.isTV ? 'squirmy.tv.token' : 'squirmy.token'}.${id}`;
  const tokens = {
    getToken: (id: string) => keychain.get(tokenKey(id)),
    setToken: (id: string, token: string) => keychain.set(tokenKey(id), token),
    removeToken: (id: string) => keychain.remove(tokenKey(id)),
  };
  // A record an earlier version wrote is removed only once its replacement is in the keychain.
  if (Platform.isTV) {
    return {
      ...tokens,
      read: () => keychain.get(tvListKey),
      write: json => keychain.set(tvListKey, json),
      legacy: async () => parseLegacy(await keychain.get(tvLegacyKey)),
      removeLegacy: async () => {
        if (!keychain.refused) await keychain.remove(tvLegacyKey);
      },
      forgetStray: async () => undefined,
    };
  }
  return {
    ...tokens,
    read: async () => readLocal(listKey),
    write: async json => writeLocal(listKey, json),
    legacy: async () => {
      const saved = parseLegacy(readLocal(legacyKey));
      return saved ? { ...saved, token: await keychain.get(legacyTokenKey) } : null;
    },
    removeLegacy: async () => {
      // Kept unless the list it moved to is really there.
      if (keychain.refused || !readLocal(listKey)) return;
      writeLocal(legacyKey, null);
      await keychain.remove(legacyTokenKey);
    },
    // The keychain outlives an uninstall. Without anything in app storage this is a fresh
    // install, so a token found there belongs to an earlier one.
    forgetStray: () => keychain.remove(legacyTokenKey),
  };
}

/** The saved accounts on this device. One per `AccountProvider`. */
export function createAccountStore(): AccountStore {
  return new AccountStore(accountBackend(), { newId: () => uuid.v4() });
}

let device: Promise<ClientDevice> | undefined;

/** This install as the server sees it. The id is generated once and kept in the keychain. */
export async function clientDevice(supportsTvDevices = false): Promise<ClientDevice> {
  device ??= (async () => {
    let id = await keychain.get(deviceKey);
    if (!id) {
      id = uuid.v4();
      await keychain.set(deviceKey, id);
    }
    const name = (Device.deviceName || Device.modelName || (Platform.isTV ? 'Apple TV' : Platform.OS === 'ios' ? 'iPhone' : 'Phone')).slice(0, 80);
    // Older servers validate this enum during login and already accept `other`.
    const kind = Platform.isTV ? 'other' : Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other';
    return { id, name, kind };
  })();
  const identity = await device;
  return Platform.isTV && supportsTvDevices ? { ...identity, kind: 'tv' } : identity;
}


const usernamesKey = 'squirmy.usernames.v1';

function readUsernames(): Record<string, string> {
  try {
    const json = globalThis.localStorage?.getItem(usernamesKey);
    return json ? JSON.parse(json) as Record<string, string> : {};
  } catch {
    return {};
  }
}

/** The username last signed in with on this server from this device, to fill in next time. */
export function lastUsername(serverUrl: string): string {
  return readUsernames()[serverUrl] ?? '';
}

export function rememberUsername(serverUrl: string, username: string): void {
  try {
    globalThis.localStorage?.setItem(usernamesKey, JSON.stringify({ ...readUsernames(), [serverUrl]: username }));
  } catch {
    // Only a convenience: the field starts empty next time.
  }
}
