import type { QueueSeed, RadioResponse } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { AppError, notFound } from '../../lib/errors.js'
import { recordingOwned } from '../catalog/availability.js'
import { resolveOne } from '../catalog/redirects.js'
import { trackSummaries } from '../catalog/summaries.js'
import { suggest, type SuggestOptions } from './ranking.js'

/** Tracks in a new radio, the seed included. */
export const RADIO_LENGTH = 50

const nothingPlayable = () => new AppError(409, 'nothing_playable', 'Nothing by this artist can be played')

async function radioFrom(userId: string, seedId: string, context: RadioResponse['context'], options: SuggestOptions): Promise<RadioResponse> {
  const [track] = await trackSummaries(userId, [{ id: seedId }])
  if (!track || track.availability === 'none') throw new AppError(409, 'not_playable', 'This track cannot be played')
  const seed: QueueSeed = {
    trackId: track.id,
    albumId: track.album?.id ?? null,
    durationMs: track.durationMs,
    state: track.availability === 'server' ? 'ready' : 'preparing',
  }
  const rest = await suggest({ userId, seeds: [track.id], exclude: [], limit: RADIO_LENGTH - 1 }, options)
  return { context: { ...context, title: context.title ?? track.title }, tracks: [seed, ...rest] }
}

/** A radio starting with the track and continuing with suggestions seeded by it. */
export async function trackRadio(userId: string, trackId: string, options: SuggestOptions = {}): Promise<RadioResponse> {
  const id = await resolveOne('recordings', trackId)
  if (!id) throw notFound('No such track')
  return radioFrom(userId, id, { type: 'radio', id: `track:${id}`, title: null }, options)
}

/**
 * A radio starting with one of the artist's top owned tracks (most played by the user,
 * then liked, then popular; ties broken at random) and continuing with suggestions.
 */
export async function artistRadio(userId: string, artistId: string, options: SuggestOptions = {}): Promise<RadioResponse> {
  const id = await resolveOne('artists', artistId)
  if (!id) throw notFound('No such artist')
  const salt = Math.floor((options.random ?? Math.random)() * 2 ** 32)
  const [top] = await db.execute<{ id: string; name: string }>(sql`
    select r.id, a.name from recordings r
    join artists a on a.id = ${id}
    -- The artist's tracks as the artist page counts them: credited, or led without credit rows.
    where r.id in (
        select ra.recording_id from recording_artists ra where ra.artist_id = ${id}
        union select led.id from recordings led where led.primary_artist_id = ${id}
      )
      and r.merged_into_id is null and ${recordingOwned('r.id')}
    order by (select count(*) from plays p where p.user_id = ${userId} and p.recording_id = r.id) desc,
      exists (select 1 from likes l where l.user_id = ${userId} and l.entity_type = 'recording' and l.entity_id = r.id) desc,
      r.popularity desc nulls last,
      uuid_hash_extended(r.id, ${salt})
    limit 1`)
  if (!top) throw nothingPlayable()
  return radioFrom(userId, top.id, { type: 'radio', id: `artist:${id}`, title: top.name }, options)
}
