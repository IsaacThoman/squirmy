import { uuid } from 'expo';
import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
import * as Network from 'expo-network';
import type { DownloadFiles, DownloadNetwork, Transfer } from './manager';
import type { NetworkKind } from './model';

/** Downloads live in the app's documents, where the system never clears them. */
function folder(): Directory {
  const directory = new Directory(Paths.document, 'downloads');
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  return directory;
}

/**
 * The downloads folder on `expo-file-system`. Transfers use a background session, so they
 * continue while the app is suspended, and pause with resume data.
 */
export function downloadFiles(): DownloadFiles {
  const directory = folder();
  const file = (name: string) => new File(directory, name);
  return {
    transfer: (url, name, onProgress): Transfer => {
      let task: DownloadTask | null = null;
      const done = (result: File | null) => result ? Number(file(name).size) : null;
      return {
        run: async () => {
          if (task) return done(await task.resumeAsync());
          task = new DownloadTask(url, file(name), {
            sessionType: 'background',
            deferBackgroundSessionCompletion: true,
            // The native events carry 64-bit integers, which arrive as BigInt whatever the types say.
            onProgress: ({ bytesWritten, totalBytes }) => onProgress(Number(bytesWritten), Number(totalBytes)),
          });
          return done(await task.downloadAsync());
        },
        pause: async () => {
          if (task?.state === 'active') await task.pauseAsync();
        },
        cancel: () => task?.cancel(),
        finish: () => void task?.acknowledgeBackgroundCompletionAsync().catch(() => undefined),
      };
    },
    fetch: async (url, name) => {
      await File.downloadFileAsync(url, file(name), { idempotent: true });
    },
    remove: name => {
      const target = file(name);
      if (target.exists) target.delete();
    },
    list: () => new Map(directory.list().flatMap(entry => entry instanceof File ? [[entry.name, Number(entry.size)] as const] : [])),
    uri: name => file(name).uri,
    newName: extension => `${uuid.v4()}.${extension}`,
  };
}

function kindOf(state: Network.NetworkState): NetworkKind {
  if (state.isConnected === false || state.type === Network.NetworkStateType.NONE) return 'none';
  if (state.type === Network.NetworkStateType.WIFI) return 'wifi';
  if (state.type === Network.NetworkStateType.CELLULAR) return 'cellular';
  return 'other';
}

/** The network type, kept current by `expo-network`. Nothing downloads until it first answers. */
export function downloadNetwork(): DownloadNetwork & { dispose: () => void } {
  let kind: NetworkKind = 'none';
  const listeners = new Set<() => void>();
  const set = (state: Network.NetworkState) => {
    const next = kindOf(state);
    if (next === kind) return;
    kind = next;
    for (const listener of [...listeners]) listener();
  };
  void Network.getNetworkStateAsync().then(set, () => undefined);
  const subscription = Network.addNetworkStateListener(set);
  return {
    kind: () => kind,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => subscription.remove(),
  };
}

/** Bytes free on the device. */
export function freeSpace(): number {
  return Paths.availableDiskSpace;
}
