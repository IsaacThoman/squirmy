import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { cacheFiles } from './files';
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

/** Bytes and songs each account keeps in the cache, by account. */
export function cacheUsage(): Map<string, { bytes: number; count: number }> {
  const rows = open().getAllSync<{ account: string; bytes: number; count: number }>(
    'SELECT account, SUM(bytes) AS bytes, COUNT(*) AS count FROM cached_tracks GROUP BY account');
  return new Map(rows.map(row => [row.account, { bytes: row.bytes, count: row.count }]));
}

/**
 * Removes what an account keeps in the cache, when no cache is running to do it (the one
 * running does it with `forgetAccount`). Only that account's files go, so a fetch in flight
 * for another account keeps its file.
 */
export function removeStreamingCache(account: string): void {
  const db = open();
  const rows = db.getAllSync<{ file: string; art: string | null }>('SELECT file, art FROM cached_tracks WHERE account = ?', account);
  db.runSync('DELETE FROM cached_tracks WHERE account = ?', account);
  const referenced = referencedCacheFiles();
  const files = cacheFiles();
  for (const row of rows) for (const name of [row.file, row.art]) if (name && !referenced.has(name)) files.remove(name);
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
    others: () => db.getAllSync<{ account: string; track_id: string; quality: CacheRow['quality']; file: string; art: string | null; bytes: number; added_at: number; played_at: number | null }>(
      'SELECT account, track_id, quality, file, art, bytes, added_at, played_at FROM cached_tracks WHERE account != ?', account,
    ).map(row => ({
      account: row.account, trackId: row.track_id, quality: row.quality, file: row.file, art: row.art, bytes: row.bytes,
      addedAt: row.added_at, playedAt: row.played_at,
    })),
    removeOthers: rows => db.withTransactionSync(() => {
      for (const row of rows) {
        db.runSync('DELETE FROM cached_tracks WHERE account = ? AND track_id = ? AND quality = ?', row.account, row.trackId, row.quality);
      }
    }),
    referencedFiles: referencedCacheFiles,
  };
}
