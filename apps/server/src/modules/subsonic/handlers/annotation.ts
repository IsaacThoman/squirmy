/** Stars (Squirmy likes), ratings and scrobbles (plays). */
import type { LikeEntityType } from '@squirmy/contracts'
import { selectFile } from '../../streaming/index.js'
import { recordExternalPlay } from '../../sessions/index.js'
import { likeEntity, setRating, unlikeEntity } from '../../userdata/likes.js'
import { expectId } from '../ids.js'
import { endNowPlaying, reportNowPlaying } from '../now-playing.js'
import { invalidParameter, missingParameter, notFound, type Context, type Handler } from '../protocol.js'
import { resolve } from './browsing.js'

const likeTypes = { track: 'track', album: 'album', artist: 'artist' } as const satisfies Record<string, LikeEntityType>

/** Every id of a star or unstar call: `id` of any kind, `albumId` and `artistId`. Checked before anything changes. */
function starTargets({ params }: Context): { type: LikeEntityType; id: string }[] {
  const targets = [
    ...params.all('id').map((value) => expectId(value, 'track', 'album', 'artist')),
    ...params.all('albumId').map((value) => expectId(value, 'album')),
    ...params.all('artistId').map((value) => expectId(value, 'artist')),
  ]
  if (targets.length === 0) throw missingParameter('id')
  return targets.map((target) => ({ type: likeTypes[target.kind], id: target.id }))
}

async function scrobble({ user, params, client }: Context) {
  const ids = params.all('id').map((value) => expectId(value, 'track').id)
  if (ids.length === 0) throw missingParameter('id')
  // Milliseconds since the epoch, from 1970 to a day ahead (clocks drift); anything else is a mistake.
  const times = params.all('time').map((value) => {
    if (!/^\d+$/.test(value) || Number(value) > Date.now() + 86_400_000) throw invalidParameter('time')
    return new Date(Number(value))
  })
  const submission = params.bool('submission') ?? true
  for (const [index, value] of ids.entries()) {
    const recordingId = await resolve('track', value)
    if (!submission) {
      reportNowPlaying(user.id, recordingId, client)
      continue
    }
    const selection = await selectFile(recordingId, { quality: 'original' })
    const recorded = await recordExternalPlay(user.id, recordingId, { playedAt: times[index] ?? new Date(), albumId: selection?.file.albumId ?? null })
    if (!recorded) throw notFound('Song')
    endNowPlaying(user.id, recordingId)
  }
  return {}
}

export const annotationEndpoints: Record<string, Handler> = {
  star: async (context) => {
    for (const target of starTargets(context)) await likeEntity(context.user.id, target.type, target.id)
    return {}
  },
  unstar: async (context) => {
    for (const target of starTargets(context)) await unlikeEntity(context.user.id, target.type, target.id)
    return {}
  },
  setRating: async ({ user, params }) => {
    const target = expectId(params.required('id'), 'track', 'album', 'artist')
    const rating = params.int('rating')
    if (rating === undefined) throw missingParameter('rating')
    if (rating < 0 || rating > 5) throw invalidParameter('rating')
    await setRating(user.id, likeTypes[target.kind], target.id, rating)
    return {}
  },
  scrobble,
}
