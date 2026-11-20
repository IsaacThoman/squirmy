import 'expo-sqlite/localStorage/install';

import type { ClientDevice, User } from '@squirmy/contracts';
import { uuid } from 'expo';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { Server } from './server';

/** The server and user are not secret; they live in app storage, which an uninstall removes. */
type Saved = { server: Server; user: User | null };

const savedKey = 'squirmy.account.v1';
const tokenKey = 'squirmy.token';
const deviceKey = 'squirmy.device-id';
// Readable while the phone is locked, so background playback can keep talking to the server.
const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

export type StoredAccount = { server: Server | null; token: string | null; user: User | null };

export async function loadAccount(): Promise<StoredAccount> {
  const saved = readSaved();
  // The keychain outlives an uninstall. Without the saved server this is a fresh install,
  // so a token found there belongs to an earlier one.
  if (!saved) {
    await SecureStore.deleteItemAsync(tokenKey, keychain).catch(() => undefined);
    return { server: null, token: null, user: null };
  }
  const token = await SecureStore.getItemAsync(tokenKey, keychain).catch(() => null);
  return { server: saved.server, token, user: token ? saved.user : null };
}

/** Saves `server`, and the session when there is one; clears whatever is not given. */
export async function saveAccount(server: Server | null, session?: { token: string; user: User }): Promise<void> {
  try {
    if (server) globalThis.localStorage?.setItem(savedKey, JSON.stringify({ server, user: session?.user ?? null } satisfies Saved));
    else globalThis.localStorage?.removeItem(savedKey);
  } catch {
    // The app still works for this launch; the next one starts at Connect.
  }
  if (session) await SecureStore.setItemAsync(tokenKey, session.token, keychain);
  else await SecureStore.deleteItemAsync(tokenKey, keychain).catch(() => undefined);
}

function readSaved(): Saved | null {
  try {
    const json = globalThis.localStorage?.getItem(savedKey);
    const saved = json ? JSON.parse(json) as Partial<Saved> : null;
    // Servers saved before the invite setting was known are assumed to require one.
    return saved?.server?.url ? {
      server: { ...saved.server, registrationRequiresInvite: saved.server.registrationRequiresInvite ?? true },
      user: saved.user ?? null,
    } : null;
  } catch {
    return null;
  }
}

let device: Promise<ClientDevice> | undefined;

/** This install as the server sees it. The id is generated once and kept in the keychain. */
export function clientDevice(): Promise<ClientDevice> {
  device ??= (async () => {
    let id = await SecureStore.getItemAsync(deviceKey, keychain).catch(() => null);
    if (!id) {
      id = uuid.v4();
      await SecureStore.setItemAsync(deviceKey, id, keychain).catch(() => undefined);
    }
    const name = (Device.deviceName || Device.modelName || (Platform.OS === 'ios' ? 'iPhone' : 'Phone')).slice(0, 80);
    const kind = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'other';
    return { id, name, kind };
  })();
  return device;
}

