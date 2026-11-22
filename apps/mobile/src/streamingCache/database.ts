import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { sweepCacheFiles } from './files';
import type { CacheIndex } from './manager';
import type { CacheRow } from './model';

let database: SQLiteDatabase | undefined;

/**
 * The streaming cache's index, in a database of its own so it never mixes with downloads.
 * It lives with the app's documents, not in the Caches folder, so it survives the system
 * emptying that folder and can tell what went. One row per account, recording and quality:
 * its file, the server's file id, size and times in columns, with the rest (the server's
 * descriptor, the track as last seen) as JSON.
 */
function open(): SQLiteDatabase {
  if (database) return database;
  database = openDatabaseSync('streaming-cache.db');
  database.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cached_tracks (
      account TEXT NOT NULL,
      track_id TEXT NOT NULL,
      quality TEXT NOT NULL,
      file TEXT NOT NULL,
      file_id TEXT NOT NULL,
      art TEXT,
      bytes INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      played_at INTEGER,
      data TEXT NOT NULL,
      PRIMARY KEY (account, track_id, quality)
    );
  `);
  return database;
}

/** Every file any account's rows use. */
export function referencedCacheFiles(): Set<string> {
  const names = new Set<string>();
  for (const row of open().getAllSync<{ file: string; art: string | null }>('SELECT file, art FROM cached_tracks')) {
    names.add(row.file);
    if (row.art) names.add(row.art);
  }
  return names;
}

/** Forgets an account's rows. Its files are then unreferenced and go with the next sweep. */
export function removeCachedAccount(account: string): void {
  open().runSync('DELETE FROM cached_tracks WHERE account = ?', account);
}

/**
 * Empties the cache of an account that signed out or switched server. A session that
 * expired keeps it, for when the same user signs in again; another user's sign-in drops it.
 */
export function removeStreamingCache(account: string): void {
  removeCachedAccount(account);
  sweepCacheFiles(referencedCacheFiles());
}

/** The index of `account` (a server and user). */
export function cacheIndex(account: string): CacheIndex {
  const db = open();
  return {
    load: () => db.getAllSync<{ data: string }>('SELECT data FROM cached_tracks WHERE account = ?', account).map(row => JSON.parse(row.data) as CacheRow),
    put: rows => db.withTransactionSync(() => {
      for (const row of rows) {
        db.runSync(`INSERT OR REPLACE INTO cached_tracks (account, track_id, quality, file, file_id, art, bytes, added_at, played_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        account, row.trackId, row.quality, row.file, row.fileId, row.art, row.bytes, row.addedAt, row.playedAt, JSON.stringify(row));
      }
    }),
    remove: rows => db.withTransactionSync(() => {
      for (const row of rows) db.runSync('DELETE FROM cached_tracks WHERE account = ? AND track_id = ? AND quality = ?', account, row.trackId, row.quality);
    }),
    removeOthers: () => {
      db.runSync('DELETE FROM cached_tracks WHERE account != ?', account);
    },
    referencedFiles: referencedCacheFiles,
  };
}
