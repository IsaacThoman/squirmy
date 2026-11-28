import { uuid } from 'expo';
import { Directory, DownloadTask, File, Paths } from 'expo-file-system';
import type { CacheFiles } from './manager';

/**
 * The cache lives in the app's Caches folder: it is not backed up, and the system may
 * empty it when the device runs short of room, which the index notices at the next launch.
 */
function folder(): Directory {
  const directory = new Directory(Paths.cache, 'streaming');
  if (!directory.exists) directory.create({ idempotent: true, intermediates: true });
  return directory;
}

/**
 * The cache folder on `expo-file-system`. Fetches run in the foreground session: the
 * cache only fills while the app runs (music playing in the background keeps it running),
 * so nothing has to survive a suspension, and a file is moved into the folder only when
 * it is complete.
 */
export function cacheFiles(): CacheFiles {
  const directory = folder();
  const file = (name: string) => new File(directory, name);
  return {
    fetch: (url, name) => {
      let total = -1;
      const task = new DownloadTask(url, file(name), {
        sessionType: 'foreground',
        // The native events carry 64-bit integers, which arrive as BigInt whatever the types say.
        onProgress: ({ totalBytes }) => { total = Number(totalBytes); },
      });
      const done = task.downloadAsync().then(result => {
        if (!result) throw new Error('The fetch stopped.');
        return { written: Number(file(name).size), total };
      });
      return { done, cancel: () => task.cancel() };
    },
    fetchSmall: async (url, name) => {
      await File.downloadFileAsync(url, file(name), { idempotent: true });
    },
    remove: name => {
      const target = file(name);
      if (target.exists) target.delete();
    },
    exists: name => file(name).exists,
    list: () => new Map(directory.exists
      ? directory.list().flatMap(entry => entry instanceof File ? [[entry.name, Number(entry.size)] as const] : []) : []),
    uri: name => file(name).uri,
    newName: extension => `${uuid.v4()}.${extension}`,
    freeBytes: () => Paths.availableDiskSpace,
  };
}
