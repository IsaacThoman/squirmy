/**
 * Merges of catalog rows. Used when a local-only row is matched to a MusicBrainz row that
 * already exists, and by other modules when MusicBrainz itself merges two ids.
 *
 * A merge re-points everything that refers to the losing row and leaves the row in place
 * with `merged_into_id` set, so old ids (in clients' caches, playback sessions, links)
 * still resolve. Collisions on unique keys keep the older like, rating, want or library save. Each merge
 * runs in one transaction (a savepoint when given one) and running it again changes
 * nothing.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm'
import type { PgTable } from 'drizzle-orm/pg-core'
import { db, type Executor, type Transaction } from '../../database/client.js'
import {
  albumArtists, albums, artists, externalIds, lyrics, mediaFiles, playlistItems, plays, recordingArtists, recordings, releases,
  releaseTracks,
} from '../../database/schema.js'
import { conflict } from '../../lib/errors.js'

type Mergeable = typeof recordings | typeof albums | typeof artists
type EntityType = 'recording' | 'album' | 'artist'

/** Follows `merged_into_id` to the row that finally holds the data. */
export async function resolveMerged(tx: Executor, table: Mergeable, id: string): Promise<string> {
  const seen = new Set<string>()
  let current = id
  for (;;) {
    if (seen.has(current)) throw new Error(`Merge cycle at ${current}`)
    seen.add(current)
    const [row] = await tx.select({ next: table.mergedIntoId }).from(table as PgTable).where(eq(table.id, current))
    if (!row?.next) return current
    current = row.next
  }
}

/**
 * Re-points per-user rows keyed on (user, entity type, entity id) from one entity to another.
 * Where the user has both, the older row wins: its values are copied onto the surviving
 * row, and the loser's row is deleted.
 */
async function moveUserRows(tx: Transaction, table: 'likes' | 'ratings' | 'wants', type: EntityType, from: string, into: string) {
  const age = table === 'ratings' ? sql.raw('updated_at') : sql.raw('created_at')
  const copy: SQL = table === 'likes'
    ? sql`created_at = f.created_at`
    : table === 'ratings'
      ? sql`rating = f.rating, updated_at = f.updated_at`
      : sql`created_at = f.created_at, fulfilled_at = f.fulfilled_at`
  const name = sql.raw(table)
  await tx.execute(sql`
    update ${name} t set ${copy} from ${name} f
    where f.entity_type = ${type} and f.entity_id = ${from}
      and t.user_id = f.user_id and t.entity_type = ${type} and t.entity_id = ${into}
      and f.${age} < t.${age}`)
  await tx.execute(sql`
    delete from ${name} f where f.entity_type = ${type} and f.entity_id = ${from}
      and exists (select 1 from ${name} t where t.user_id = f.user_id and t.entity_type = ${type} and t.entity_id = ${into})`)
  await tx.execute(sql`update ${name} set entity_id = ${into} where entity_type = ${type} and entity_id = ${from}`)
}

/** Re-points plays of the collection (`collection_plays`); where the user played both, the later play is kept. */
async function moveCollectionPlays(tx: Transaction, type: 'album' | 'artist', from: string, into: string) {
  await tx.execute(sql`
    update collection_plays t set played_at = f.played_at from collection_plays f
    where f.entity_type = ${type} and f.entity_id = ${from}
      and t.user_id = f.user_id and t.entity_type = ${type} and t.entity_id = ${into}
      and f.played_at > t.played_at`)
  await tx.execute(sql`
    delete from collection_plays f where f.entity_type = ${type} and f.entity_id = ${from}
      and exists (select 1 from collection_plays t where t.user_id = f.user_id and t.entity_type = ${type} and t.entity_id = ${into})`)
  await tx.execute(sql`update collection_plays set entity_id = ${into} where entity_type = ${type} and entity_id = ${from}`)
}

async function moveExternalIds(tx: Transaction, type: EntityType, from: string, into: string) {
  await tx.update(externalIds).set({ entityId: into }).where(sql`${externalIds.entityType} = ${type} and ${externalIds.entityId} = ${from}`)
}

/** Resolves both ids and refuses a merge that would close a cycle. Null means nothing to do. */
async function target(tx: Transaction, table: Mergeable, fromId: string, intoId: string): Promise<string | null> {
  const into = await resolveMerged(tx, table, intoId)
  if (into === fromId) {
    if (intoId === fromId) return null
    throw conflict('That merge would make a row redirect to itself', 'merge_cycle')
  }
  const [from] = await tx.select({ id: table.id }).from(table as PgTable).where(eq(table.id, fromId)).for('update')
  if (!from) throw new Error(`No row ${fromId} to merge`)
  return into
}

/** Marks the loser merged, and points rows that redirected to it straight at the winner. */
async function redirect(tx: Transaction, table: Mergeable, from: string, into: string) {
  const now = new Date()
  await tx.update(table).set({ mergedIntoId: into, updatedAt: now }).where(and(eq(table.id, from), sql`${table.mergedIntoId} is distinct from ${into}`))
  await tx.update(table).set({ mergedIntoId: into, updatedAt: now }).where(eq(table.mergedIntoId, from))
}

/**
 * Merges recording `fromId` into `intoId`: files, release tracks, external ids, lyrics
 * (the winner's are kept), library saves (likes), ratings, playlist items, plays and wants,
 * and its ISRCs and explicit flag. The winner keeps its own artist credits; the loser's
 * move only when the winner has none.
 */
export async function mergeRecording(fromId: string, intoId: string, executor: Executor = db): Promise<void> {
  await executor.transaction(async (tx) => {
    const into = await target(tx, recordings, fromId, intoId)
    if (!into) return
    await tx.update(mediaFiles).set({ recordingId: into, updatedAt: new Date() }).where(eq(mediaFiles.recordingId, fromId))
    await tx.update(releaseTracks).set({ recordingId: into }).where(eq(releaseTracks.recordingId, fromId))
    await tx.update(playlistItems).set({ recordingId: into }).where(eq(playlistItems.recordingId, fromId))
    await tx.update(plays).set({ recordingId: into }).where(eq(plays.recordingId, fromId))
    await tx.execute(sql`
      update ${lyrics} set recording_id = ${into} where recording_id = ${fromId}
        and not exists (select 1 from ${lyrics} l where l.recording_id = ${into})`)
    await tx.delete(lyrics).where(eq(lyrics.recordingId, fromId))
    await tx.execute(sql`
      update ${recordingArtists} set recording_id = ${into} where recording_id = ${fromId}
        and not exists (select 1 from ${recordingArtists} r where r.recording_id = ${into})`)
    await moveExternalIds(tx, 'recording', fromId, into)
    for (const table of ['likes', 'ratings', 'wants'] as const) await moveUserRows(tx, table, 'recording', fromId, into)
    // ISRCs and the explicit flag are facts about the sound, so the winner learns the
    // loser's (MusicBrainz rows have no explicit flag; the Deezer rows they absorb do).
    await tx.execute(sql`
      update ${recordings} r set isrcs = array(select distinct unnest(r.isrcs || f.isrcs))
      from ${recordings} f where r.id = ${into} and f.id = ${fromId} and not (f.isrcs <@ r.isrcs)`)
    await tx.execute(sql`
      update ${recordings} r set explicit = f.explicit
      from ${recordings} f where r.id = ${into} and f.id = ${fromId} and r.explicit is null and f.explicit is not null`)
    await redirect(tx, recordings, fromId, into)
  })
}

/**
 * Merges album `fromId` into `intoId`: files, editions (releases), external ids, likes,
 * ratings, wants, library saves, playlist items, plays, collection plays and album hints. The winner keeps its own credits, and takes
 * the loser's artwork, canonical release, year and date only when it has none.
 */
export async function mergeAlbum(fromId: string, intoId: string, executor: Executor = db): Promise<void> {
  await executor.transaction(async (tx) => {
    const into = await target(tx, albums, fromId, intoId)
    if (!into) return
    await tx.update(mediaFiles).set({ albumId: into, updatedAt: new Date() }).where(eq(mediaFiles.albumId, fromId))
    await tx.update(releases).set({ albumId: into, updatedAt: new Date() }).where(eq(releases.albumId, fromId))
    await tx.update(playlistItems).set({ albumId: into }).where(eq(playlistItems.albumId, fromId))
    await tx.update(plays).set({ albumId: into }).where(eq(plays.albumId, fromId))
    // Search cleanup keeps an album that a recording hints at, so a hint left on the loser
    // would keep the redirect row alive for nothing.
    await tx.update(recordings).set({ albumHintId: into }).where(eq(recordings.albumHintId, fromId))
    await tx.execute(sql`
      update ${albumArtists} set album_id = ${into} where album_id = ${fromId}
        and not exists (select 1 from ${albumArtists} a where a.album_id = ${into})`)
    await moveExternalIds(tx, 'album', fromId, into)
    for (const table of ['likes', 'ratings', 'wants'] as const) await moveUserRows(tx, table, 'album', fromId, into)
    await moveCollectionPlays(tx, 'album', fromId, into)
    await tx.execute(sql`
      update ${albums} a set
        artwork_asset_id = coalesce(a.artwork_asset_id, f.artwork_asset_id),
        canonical_release_id = coalesce(a.canonical_release_id, f.canonical_release_id),
        year = coalesce(a.year, f.year),
        release_date = coalesce(a.release_date, f.release_date)
      from ${albums} f where a.id = ${into} and f.id = ${fromId}`)
    await redirect(tx, albums, fromId, into)
  })
}

/**
 * Merges artist `fromId` into `intoId`: album and recording credits, primary artists,
 * external ids, likes, ratings and collection plays. The winner takes the loser's image and disambiguation
 * only when it has none.
 */
export async function mergeArtist(fromId: string, intoId: string, executor: Executor = db): Promise<void> {
  await executor.transaction(async (tx) => {
    const into = await target(tx, artists, fromId, intoId)
    if (!into) return
    await tx.update(albumArtists).set({ artistId: into }).where(eq(albumArtists.artistId, fromId))
    await tx.update(recordingArtists).set({ artistId: into }).where(eq(recordingArtists.artistId, fromId))
    await tx.update(albums).set({ primaryArtistId: into }).where(eq(albums.primaryArtistId, fromId))
    await tx.update(recordings).set({ primaryArtistId: into }).where(eq(recordings.primaryArtistId, fromId))
    await moveExternalIds(tx, 'artist', fromId, into)
    for (const table of ['likes', 'ratings'] as const) await moveUserRows(tx, table, 'artist', fromId, into)
    await moveCollectionPlays(tx, 'artist', fromId, into)
    await tx.execute(sql`
      update ${artists} a set image_asset_id = coalesce(a.image_asset_id, f.image_asset_id),
        disambiguation = coalesce(a.disambiguation, f.disambiguation),
        -- Either row's picture may be a namesake's (search links Deezer pages by name), so
        -- the merged artist's is chosen again (enrichment/artist.ts).
        image_picked_at = null
      from ${artists} f where a.id = ${into} and f.id = ${fromId}`)
    await redirect(tx, artists, fromId, into)
  })
}
