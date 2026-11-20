import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import type { DownloadIndex } from './manager';
import type { CollectionRow, DownloadRow } from './model';

let database: SQLiteDatabase | undefined;

/**
 * The downloads index. Each recording has one row per account: its file, quality, size,
 * album context and when it was added, in columns, with the rest (the track and album as
 * last seen, retries, the server's descriptor) as JSON so it shows with no connection.
 */
function open(): SQLiteDatabase {
  if (database) return database;
  database = openDatabaseSync('downloads.db');
  database.execSync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS downloads (
      account TEXT NOT NULL,
      track_id TEXT NOT NULL,
      album_id TEXT,
      state TEXT NOT NULL,
      quality TEXT NOT NULL,
      file TEXT,
      art TEXT,
      bytes INTEGER,
      added_at INTEGER NOT NULL,
      done_at INTEGER,
      data TEXT NOT NULL,
      PRIMARY KEY (account, track_id)
    );
    CREATE TABLE IF NOT EXISTS download_collections (
      account TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      art TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (account, id)
    );
  `);
  return database;
}

/** The index of `account` (a server and user). */
export function downloadIndex(account: string): DownloadIndex {
  const db = open();
  return {
    load: () => ({
      downloads: db.getAllSync<{ data: string }>('SELECT data FROM downloads WHERE account = ?', account).map(row => JSON.parse(row.data) as DownloadRow),
      collections: db.getAllSync<{ data: string }>('SELECT data FROM download_collections WHERE account = ?', account)
        .map(row => JSON.parse(row.data) as CollectionRow),
    }),
    putDownloads: rows => db.withTransactionSync(() => {
      for (const row of rows) {
        db.runSync(`INSERT OR REPLACE INTO downloads (account, track_id, album_id, state, quality, file, art, bytes, added_at, done_at, data)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        account, row.trackId, row.albumId, row.state, row.quality, row.file, row.art, row.bytes, row.addedAt, row.doneAt, JSON.stringify(row));
      }
    }),
    removeDownloads: trackIds => db.withTransactionSync(() => {
      for (const trackId of trackIds) db.runSync('DELETE FROM downloads WHERE account = ? AND track_id = ?', account, trackId);
    }),
    putCollection: row => {
      db.runSync('INSERT OR REPLACE INTO download_collections (account, id, kind, art, data) VALUES (?, ?, ?, ?, ?)',
        account, row.id, row.kind, JSON.stringify(row.art), JSON.stringify(row));
    },
    removeCollection: id => {
      db.runSync('DELETE FROM download_collections WHERE account = ? AND id = ?', account, id);
    },
    referencedFiles: () => {
      const names = new Set<string>();
      for (const row of db.getAllSync<{ file: string | null; art: string | null }>('SELECT file, art FROM downloads')) {
        if (row.file) names.add(row.file);
        if (row.art) names.add(row.art);
      }
      for (const row of db.getAllSync<{ art: string }>('SELECT art FROM download_collections')) {
        for (const name of JSON.parse(row.art) as string[]) names.add(name);
      }
      return names;
    },
  };
}
