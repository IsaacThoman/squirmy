import type postgres from 'postgres'
import { getSql } from '../../database/client.js'

// The migration creates these on empty tables. The worker uses the same expressions
// for upgrades with data, where a boot-time build would take an exclusive write lock.
export const librarySearchIndexes = {
  albums_match_key_unicode: 'on albums using gin (search_unicode_bigrams(match_key))',
  artists_name_key_unicode: 'on artists using gin (search_unicode_bigrams(name_key))',
  lyrics_search: "on lyrics using gin (to_tsvector('simple', search_lyric_text(plain, synced))) where not instrumental",
  recordings_match_key_unicode: 'on recordings using gin (search_unicode_bigrams(match_key))',
}
type LibrarySearchIndex = keyof typeof librarySearchIndexes
export const librarySearchIndexNames = Object.keys(librarySearchIndexes) as LibrarySearchIndex[]

export async function searchIndexValidity(names: readonly string[], sql: postgres.ISql = getSql()) {
  const rows = await sql<{ name: string; valid: boolean }[]>`
    select c.relname as name, i.indisvalid as valid
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relnamespace = 'public'::regnamespace and c.relname = any(${names}::name[])`
  return new Map(rows.map(({ name, valid }) => [name, valid]))
}
