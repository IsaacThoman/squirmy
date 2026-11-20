/**
 * Stores catalog search results as catalog rows, so every result has a normal id and
 * opens through the ordinary artist, album and track routes.
 *
 * Each provider result is matched to an existing row, most reliable first:
 * 1. its id in `external_ids` (provider, type, id);
 * 2. its MBID;
 * 3. its key. Artists: the one artist with that `name_key`, when exactly one exists.
 *    Albums and tracks: the same artist (by credit or by primary artist) and the same
 *    title once edition suffixes are dropped (keys.ts), so "OK Computer (Deluxe
 *    Edition)" finds an owned "OK Computer". Owned rows win over others.
 * Only then is a stub inserted (`detail_level` 0, no releases). The enrichment module
 * completes a stub when it is opened. An album or track found by id or MBID that the user
 * does not own still gives way to an owned one found by key, and its provider id moves
 * there: music added to the library after it was first searched shows as owned.
 *
 * Existing rows are never changed, except that a missing external id, image or album
 * hint is added. One transaction per response, serialized by an advisory lock, makes
 * concurrent identical searches create each stub once.
 */
import { inArray, sql, type SQL } from 'drizzle-orm'
import { db, type Executor, type Transaction } from '../../database/client.js'
import { albumArtists, albums, artists, externalIds, recordingArtists, recordings, type CatalogEntityType } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'
import { remoteImage } from '../artwork/index.js'
import { recordingOwned } from '../catalog/availability.js'
import { resolveMerged } from '../catalog/redirects.js'
import { uuidArray } from '../catalog/sql.js'
import { editionFreeKey, prefixEnd, textArray } from './keys.js'
import { artistOwned } from './library.js'
import type { IdSource, ProviderAlbum, ProviderArtist, ProviderCredit, ProviderResults, ProviderTrack } from './providers.js'

/** Catalog ids of a response's results, in provider order, without duplicates. */
export type StubIds = { artists: string[]; albums: string[]; tracks: string[] }

/** Two recordings of one song differ in length by less than this; more means another version. */
const durationToleranceMs = 10_000

/** Serializes everything that creates or deletes search stubs. Held until the transaction ends. */
export async function lockStubs(tx: Executor) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('squirmy:search-stubs'))`)
}

/** Identity of a credited artist within one response. */
function artistRef(artist: { id: string | null; mbid: string | null; name: string }): string {
  return artist.id ? `id:${artist.id}` : artist.mbid ? `mbid:${artist.mbid}` : `name:${matchKey(artist.name)}`
}

/** Identity of an album within one response. */
function albumRef(album: ProviderAlbum): string {
  return album.id ? `id:${album.id}` : `key:${creditKey(album.artistCredit, album.title)}`
}

const unique = (ids: (string | null | undefined)[]) => [...new Set(ids.filter((id): id is string => Boolean(id)))]
const compatible = (existing: string | null, wanted: string | null) => !existing || !wanted || existing === wanted

/** Rows already known under the provider's ids, keyed by external id, after merges. */
async function byExternalId(tx: Transaction, source: IdSource, type: CatalogEntityType, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await tx.execute<{ externalId: string; entityId: string }>(sql`
    select external_id as "externalId", entity_id as "entityId" from external_ids
    where provider = ${source} and entity_type = ${type} and external_id = any(${textArray(ids)})`)
  return new Map(rows.map((row) => [row.externalId, row.entityId]))
}

/** Rows with these MBIDs, keyed by MBID. */
async function byMbid(tx: Transaction, table: 'artists' | 'albums' | 'recordings', mbids: string[]): Promise<Map<string, string>> {
  if (mbids.length === 0) return new Map()
  const rows = await tx.execute<{ id: string; mbid: string }>(sql`
    select id, mbid from ${sql.identifier(table)} where mbid = any(${uuidArray(mbids)})`)
  return new Map(rows.map((row) => [row.mbid, row.id]))
}

type StubTable = typeof artists | typeof albums | typeof recordings

/**
 * Inserts stub rows and returns, per planned id, the id the row ended up with. A row whose
 * MBID another writer inserted meanwhile is not inserted; the existing row stands in.
 */
async function insertStubs(tx: Transaction, table: StubTable, rows: { id: string; mbid: string | null }[]): Promise<Map<string, string>> {
  const ids = new Map(rows.map((row) => [row.id, row.id]))
  if (rows.length === 0) return ids
  const target = table as typeof artists
  const inserted = new Set((await tx.insert(target).values(rows as never[]).onConflictDoNothing().returning({ id: target.id })).map((row) => row.id))
  const lost = rows.filter((row) => !inserted.has(row.id))
  if (lost.length > 0) {
    const existing = await tx.select({ id: target.id, mbid: target.mbid }).from(target).where(inArray(target.mbid, lost.map((row) => row.mbid!)))
    for (const row of lost) ids.set(row.id, existing.find((one) => one.mbid === row.mbid)!.id)
  }
  return ids
}

/** Owned when a present file links to the album or recording. */
const owns = {
  albums: (alias: string) => sql.raw(`exists (select 1 from media_files f where f.album_id = ${alias}.id and f.missing_since is null)`),
  recordings: (alias: string) => recordingOwned(`${alias}.id`),
}

/**
 * Rows found by the provider's id or MBID, after merges, keyed like `refs`, and which of
 * them the user owns. A row the user does not own may still give way to an owned one
 * found by key: music added after it was first searched.
 */
async function knownRows(tx: Transaction, table: 'albums' | 'recordings', found: Map<string, string>) {
  await followMerges(tx, table, found)
  const ids = unique([...found.values()])
  const owned = ids.length === 0 ? [] : await tx.execute<{ id: string }>(sql`
    select t.id from ${sql.identifier(table)} t where t.id = any(${uuidArray(ids)}) and ${owns[table]('t')}`)
  return new Set(owned.map((row) => row.id))
}

/** Points provider ids at the owned rows that replace the stubs they named. */
async function moveExternalIds(tx: Transaction, source: IdSource, type: CatalogEntityType, moves: [externalId: string, entityId: string][]) {
  for (const [externalId, entityId] of moves) {
    await tx.execute(sql`update external_ids set entity_id = ${entityId} where provider = ${source} and entity_type = ${type} and external_id = ${externalId}`)
  }
}

async function addExternalIds(tx: Transaction, source: IdSource, type: CatalogEntityType, pairs: [externalId: string | null, entityId: string][]) {
  const rows = pairs.flatMap(([externalId, entityId]) => (externalId ? [{ provider: source, entityType: type, externalId, entityId }] : []))
  if (rows.length > 0) await tx.insert(externalIds).values(rows).onConflictDoNothing()
}

/** Asset ids of remote images by URL. */
type Images = Map<string, string>

/** Registers remote images without downloading anything. */
async function images(urls: (string | null)[], kind: 'cover' | 'artist'): Promise<Images> {
  const assets = await Promise.all(unique(urls).map(async (url) => [url, (await remoteImage(url, { kind })).id] as const))
  return new Map(assets)
}

type ArtistInput = { id: string | null; mbid: string | null; name: string; imageUrl: string | null }

/**
 * Resolves every artist of the response (results and credits) to a row id, keyed by
 * `artistRef`. A credit without any provider id reuses the artist with its name, owned
 * first, and only otherwise becomes a stub with no external id.
 */
async function resolveArtists(tx: Transaction, source: IdSource, inputs: ArtistInput[], assets: Images): Promise<Map<string, string>> {
  const refs = new Map<string, ArtistInput>()
  for (const input of inputs) {
    const known = refs.get(artistRef(input))
    if (known) known.imageUrl ??= input.imageUrl
    else refs.set(artistRef(input), { ...input })
  }
  const list = [...refs.values()]
  const external = await byExternalId(tx, source, 'artist', unique(list.map((ref) => ref.id)))
  const mbids = await byMbid(tx, 'artists', unique(list.map((ref) => ref.mbid)))
  const named = await tx.execute<{ id: string; nameKey: string; mbid: string | null; owned: boolean; hasSourceId: boolean }>(sql`
    select a.id, a.name_key as "nameKey", a.mbid,
      ${artistOwned('a')} as owned,
      exists (select 1 from external_ids e where e.provider = ${source} and e.entity_type = 'artist' and e.entity_id = a.id) as "hasSourceId"
    from artists a
    where a.name_key = any(${textArray(unique(list.map((ref) => matchKey(ref.name))))}) and a.merged_into_id is null
    order by owned desc, a.id`)

  const resolved = new Map<string, string>()
  const stubs: (typeof artists.$inferInsert & { id: string; mbid: string | null })[] = []
  const planned = new Map<string, ArtistInput>()
  for (const [key, ref] of refs) {
    const sameName = named.filter((row) => row.nameKey === matchKey(ref.name))
    let id = (ref.id && external.get(ref.id)) || (ref.mbid && mbids.get(ref.mbid)) || undefined
    if (!id && (ref.id || ref.mbid)) {
      const only = sameName.length === 1 ? sameName[0]! : undefined
      // An artist already known under another id of this provider is someone else.
      if (only && compatible(only.mbid, ref.mbid) && !(ref.id && only.hasSourceId)) id = only.id
    } else if (!id) {
      id = sameName[0]?.id
    }
    if (id) resolved.set(key, id)
    else {
      const stubId = newId()
      planned.set(stubId, ref)
      stubs.push({ id: stubId, mbid: ref.mbid, name: ref.name, sortName: ref.name, nameKey: matchKey(ref.name), detailLevel: 0 })
    }
  }
  await followMerges(tx, 'artists', resolved)

  for (const stub of stubs) stub.imageAssetId = assets.get(planned.get(stub.id)!.imageUrl ?? '') ?? null
  for (const [planId, id] of await insertStubs(tx, artists, stubs)) resolved.set(artistRef(planned.get(planId)!), id)

  await addExternalIds(tx, source, 'artist', [...refs].map(([key, ref]) => [ref.id, resolved.get(key)!]))
  for (const [key, ref] of refs) {
    const assetId = assets.get(ref.imageUrl ?? '')
    if (assetId) await tx.execute(sql`update artists set image_asset_id = ${assetId} where id = ${resolved.get(key)!} and image_asset_id is null`)
  }
  return resolved
}

/** Replaces the ids in `found` with the rows they were merged into. */
async function followMerges(tx: Transaction, table: 'artists' | 'albums' | 'recordings', found: Map<string, string>) {
  if (found.size === 0) return
  const targets = await resolveMerged(table, [...found.values()], tx)
  for (const [key, id] of found) found.set(key, targets.get(id) ?? id)
}

type KeyCandidate = {
  i: number
  id: string
  title: string
  mbid: string | null
  owned: boolean
}

/**
 * Rows by the same artist (credit text or primary artist) whose title starts with each
 * wanted edition-free title, for the caller to filter. `i` is the 1-based position of
 * the wanted entry.
 */
function keyCandidates(table: 'albums' | 'recordings', wanted: { title: string; credit: string; artistId: string | null }[], extra: SQL) {
  return sql`
    select k.i::int as i, t.id, t.title, t.mbid, ${extra}
    from unnest(${textArray(wanted.map((one) => one.title))}, ${textArray(wanted.map((one) => prefixEnd(one.title)))},
                ${textArray(wanted.map((one) => one.credit))}, ${uuidArray(wanted.map((one) => one.artistId))})
      with ordinality as k(title, title_end, credit, artist_id, i)
    join ${sql.identifier(table)} t on t.title_key collate "C" >= k.title and t.title_key collate "C" < k.title_end
      and t.merged_into_id is null
      and (split_part(t.match_key, '|', 1) = k.credit or t.primary_artist_id = k.artist_id)`
}

/** Credit rows for a new album or recording, in credit order. */
function creditRows(credits: ProviderCredit[], artistIds: Map<string, string>) {
  return credits.map((credit, position) => ({ position, artistId: artistIds.get(artistRef(credit))!, creditedName: credit.name, joinPhrase: credit.joinPhrase }))
}

/** Resolves albums to row ids, keyed by `albumRef`. Albums without a provider id are only looked up. */
async function resolveAlbums(tx: Transaction, source: IdSource, inputs: ProviderAlbum[], artistIds: Map<string, string>, covers: Images): Promise<Map<string, string>> {
  const refs = new Map<string, ProviderAlbum>()
  for (const input of inputs) if (!refs.has(albumRef(input))) refs.set(albumRef(input), input)
  const list = [...refs.values()]
  const external = await byExternalId(tx, source, 'album', unique(list.map((ref) => ref.id)))
  const mbids = await byMbid(tx, 'albums', unique(list.map((ref) => ref.mbid)))

  const known = new Map<string, string>()
  for (const [key, ref] of refs) {
    const id = (ref.id && external.get(ref.id)) || (ref.mbid && mbids.get(ref.mbid))
    if (id) known.set(key, id)
  }
  const ownedKnown = await knownRows(tx, 'albums', known)
  const resolved = new Map<string, string>()
  const open: [string, ProviderAlbum][] = []
  for (const [key, ref] of refs) {
    const id = known.get(key)
    if (id && ownedKnown.has(id)) resolved.set(key, id)
    else if (editionFreeKey(ref.title)) open.push([key, ref])
    else if (id) resolved.set(key, id)
  }
  const primary = (ref: ProviderAlbum) => (ref.artists[0] ? artistIds.get(artistRef(ref.artists[0])) ?? null : null)
  const wanted = open.map(([, ref]) => ({ title: editionFreeKey(ref.title), credit: matchKey(ref.artistCredit), artistId: primary(ref) }))
  const candidates = wanted.length === 0 ? [] : await tx.execute<KeyCandidate & { type: string; detailLevel: number }>(sql`
    ${keyCandidates('albums', wanted, sql`t.type, t.detail_level as "detailLevel", ${owns.albums('t')} as owned`)}
    order by owned desc, t.detail_level desc, t.id`)

  // Albums of this response that match nothing yet, grouped so that one stub stands for each album.
  const groups = new Map<string, { id: string; refs: string[] }>()
  const stubs: (typeof albums.$inferInsert & { id: string; mbid: string | null })[] = []
  const credits: (typeof albumArtists.$inferInsert)[] = []
  const moves: [string, string][] = []
  for (const [index, [key, ref]] of open.entries()) {
    const fallback = known.get(key)
    const match = candidates.find((row) => row.i === index + 1 && editionFreeKey(row.title) === wanted[index]!.title
      && compatible(row.mbid, ref.mbid) && (row.owned || (!fallback && row.type === ref.type)))
    if (match) {
      resolved.set(key, match.id)
      if (ref.id && external.get(ref.id) === fallback) moves.push([ref.id, match.id])
      continue
    }
    if (fallback) {
      resolved.set(key, fallback)
      continue
    }
    if (!ref.id) continue
    const groupKey = `${wanted[index]!.artistId ?? wanted[index]!.credit}|${wanted[index]!.title}|${ref.type}`
    const group = groups.get(groupKey)
    if (group) {
      group.refs.push(key)
      continue
    }
    const id = newId()
    groups.set(groupKey, { id, refs: [key] })
    stubs.push({
      id,
      mbid: ref.mbid,
      title: ref.title,
      artistCredit: ref.artistCredit,
      primaryArtistId: wanted[index]!.artistId,
      type: ref.type,
      year: ref.year,
      releaseDate: ref.releaseDate,
      titleKey: matchKey(ref.title),
      matchKey: creditKey(ref.artistCredit, ref.title),
      artworkAssetId: covers.get(ref.artworkUrl ?? '') ?? null,
      detailLevel: 0,
    })
    credits.push(...creditRows(ref.artists, artistIds).map((credit) => ({ ...credit, albumId: id })))
  }
  const inserted = await insertStubs(tx, albums, stubs)
  const kept = credits.filter((credit) => inserted.get(credit.albumId) === credit.albumId)
  if (kept.length > 0) await tx.insert(albumArtists).values(kept)
  for (const group of groups.values()) for (const key of group.refs) resolved.set(key, inserted.get(group.id)!)

  await moveExternalIds(tx, source, 'album', moves)
  await addExternalIds(tx, source, 'album', [...refs].flatMap(([key, ref]) => (resolved.has(key) ? [[ref.id, resolved.get(key)!]] : [])))
  for (const [key, ref] of refs) {
    const assetId = covers.get(ref.artworkUrl ?? '')
    if (assetId && resolved.has(key)) {
      await tx.execute(sql`update albums set artwork_asset_id = ${assetId} where id = ${resolved.get(key)!} and artwork_asset_id is null`)
    }
  }
  return resolved
}

/** Resolves tracks to recording ids, in input order. */
async function resolveTracks(tx: Transaction, source: IdSource, tracks: ProviderTrack[], artistIds: Map<string, string>, albumIds: Map<string, string>): Promise<string[]> {
  const refs = new Map<string, ProviderTrack>()
  for (const track of tracks) if (!refs.has(track.id)) refs.set(track.id, track)
  const external = await byExternalId(tx, source, 'recording', [...refs.keys()])
  const mbids = await byMbid(tx, 'recordings', unique([...refs.values()].map((ref) => ref.mbid)))

  const known = new Map<string, string>()
  for (const [key, ref] of refs) {
    const id = external.get(ref.id) || (ref.mbid && mbids.get(ref.mbid))
    if (id) known.set(key, id)
  }
  const ownedKnown = await knownRows(tx, 'recordings', known)
  const resolved = new Map<string, string>()
  const open: ProviderTrack[] = []
  for (const [key, ref] of refs) {
    const id = known.get(key)
    if (id && ownedKnown.has(id)) resolved.set(key, id)
    else if (editionFreeKey(ref.title)) open.push(ref)
    else if (id) resolved.set(key, id)
  }
  const primary = (ref: ProviderTrack) => (ref.artists[0] ? artistIds.get(artistRef(ref.artists[0])) ?? null : null)
  const wanted = open.map((ref) => ({ title: editionFreeKey(ref.title), credit: matchKey(ref.artistCredit), artistId: primary(ref) }))
  const candidates = wanted.length === 0 ? [] : await tx.execute<KeyCandidate & { durationMs: number | null }>(sql`
    ${keyCandidates('recordings', wanted, sql`t.duration_ms as "durationMs", ${owns.recordings('t')} as owned,
      exists (select 1 from release_tracks rt where rt.recording_id = t.id) as "onRelease"`)}
    order by owned desc, "onRelease" desc, t.id`)

  const groups = new Map<string, string>()
  const stubs: (typeof recordings.$inferInsert & { id: string; mbid: string | null })[] = []
  const credits: (typeof recordingArtists.$inferInsert)[] = []
  const planned = new Map<string, string>()
  const moves: [string, string][] = []
  for (const [index, ref] of open.entries()) {
    const fallback = known.get(ref.id)
    const close = (durationMs: number | null) => !durationMs || !ref.durationMs || Math.abs(durationMs - ref.durationMs) < durationToleranceMs
    const match = candidates.find((row) => row.i === index + 1 && editionFreeKey(row.title) === wanted[index]!.title
      && compatible(row.mbid, ref.mbid) && close(row.durationMs) && (row.owned || !fallback))
    if (match) {
      resolved.set(ref.id, match.id)
      if (external.get(ref.id) === fallback) moves.push([ref.id, match.id])
      continue
    }
    if (fallback) {
      resolved.set(ref.id, fallback)
      continue
    }
    const groupKey = `${wanted[index]!.artistId ?? wanted[index]!.credit}|${wanted[index]!.title}`
    const existing = groups.get(groupKey)
    if (existing) {
      planned.set(ref.id, existing)
      continue
    }
    const id = newId()
    groups.set(groupKey, id)
    planned.set(ref.id, id)
    stubs.push({
      id,
      mbid: ref.mbid,
      title: ref.title,
      artistCredit: ref.artistCredit,
      primaryArtistId: wanted[index]!.artistId,
      durationMs: ref.durationMs,
      isrcs: ref.isrcs,
      titleKey: matchKey(ref.title),
      matchKey: creditKey(ref.artistCredit, ref.title),
      popularity: ref.popularity,
      explicit: ref.explicit,
      albumHintId: ref.album ? albumIds.get(albumRef(ref.album)) ?? null : null,
    })
    credits.push(...creditRows(ref.artists, artistIds).map((credit) => ({ ...credit, recordingId: id })))
  }
  const inserted = await insertStubs(tx, recordings, stubs)
  const kept = credits.filter((credit) => inserted.get(credit.recordingId) === credit.recordingId)
  if (kept.length > 0) await tx.insert(recordingArtists).values(kept)
  for (const [key, planId] of planned) resolved.set(key, inserted.get(planId)!)

  await moveExternalIds(tx, source, 'recording', moves)
  await addExternalIds(tx, source, 'recording', [...refs].map(([key]) => [key, resolved.get(key)!]))
  // A stub found again may not have had an album yet.
  for (const [key, ref] of refs) {
    const hint = ref.album ? albumIds.get(albumRef(ref.album)) : undefined
    if (hint) {
      await tx.execute(sql`
        update recordings r set album_hint_id = ${hint}
        where r.id = ${resolved.get(key)!} and r.album_hint_id is null
          and not exists (select 1 from release_tracks rt where rt.recording_id = r.id)`)
    }
  }
  return tracks.map((track) => resolved.get(track.id)!)
}

/**
 * Stores `results` of a provider whose ids are `source`'s and returns their catalog ids.
 * Idempotent: the same results again give the same ids and add no rows.
 */
export async function materialize(source: IdSource, results: ProviderResults): Promise<StubIds> {
  if (results.artists.length + results.albums.length + results.tracks.length === 0) return { artists: [], albums: [], tracks: [] }
  const albumInputs = [...results.albums, ...results.tracks.flatMap((track) => (track.album ? [track.album] : []))]
  // Registered before the transaction: once it holds the lock every query goes through it,
  // or searches queued on the lock could hold every pooled connection the holder needs.
  const [artistImages, covers] = await Promise.all([
    images(results.artists.map((artist) => artist.imageUrl), 'artist'),
    images(albumInputs.map((album) => album.artworkUrl), 'cover'),
  ])
  return db.transaction(async (tx) => {
    await lockStubs(tx)
    const artistIds = await resolveArtists(tx, source, [
      ...results.artists,
      ...[...albumInputs, ...results.tracks].flatMap((item) => item.artists.map((credit) => ({ ...credit, imageUrl: null }))),
    ], artistImages)
    const albumIds = await resolveAlbums(tx, source, albumInputs, artistIds, covers)
    const trackIds = await resolveTracks(tx, source, results.tracks, artistIds, albumIds)
    return {
      artists: unique(results.artists.map((artist: ProviderArtist) => artistIds.get(artistRef(artist)))),
      albums: unique(results.albums.map((album) => albumIds.get(albumRef(album)))),
      tracks: unique(trackIds),
    }
  })
}
