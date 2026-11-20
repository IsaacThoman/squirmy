import { z } from 'zod'
import { PlaybackContext, QueueSeed } from './session.js'

/**
 * `POST /api/v1/radio/track/:id` and `POST /api/v1/radio/artist/:id`: about 50 tracks,
 * the first being the seed track (for an artist, one of its top owned tracks). Play them
 * with the `playTracks` session command and this `context`, whose `type` is `radio` and
 * whose `id` is `track:<id>` or `artist:<id>`. With autoplay on, the session keeps the
 * radio going from the tracks just played once these run out.
 */
export const RadioResponse = z.object({ context: PlaybackContext, tracks: z.array(QueueSeed).min(1) })
export type RadioResponse = z.infer<typeof RadioResponse>
