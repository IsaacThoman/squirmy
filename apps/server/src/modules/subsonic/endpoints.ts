/**
 * Every method, by area. Names match the specification; lookups ignore case. Find a
 * method's handler in the file of its area under handlers/.
 */
import { annotationEndpoints } from './handlers/annotation.js'
import { browsingEndpoints } from './handlers/browsing.js'
import { listEndpoints } from './handlers/lists.js'
import { negotiationEndpoints } from './handlers/negotiation.js'
import { mediaEndpoints } from './handlers/media.js'
import { playlistEndpoints } from './handlers/playlists.js'
import { queueEndpoints } from './handlers/queue.js'
import { searchEndpoints } from './handlers/search.js'
import { sonicEndpoints } from './handlers/sonic.js'
import { systemEndpoints } from './handlers/system.js'
import type { Handler } from './protocol.js'

export type Endpoint = {
  handler: Handler
  /** Answers without credentials (getOpenSubsonicExtensions must). */
  public?: boolean
  admin?: boolean
  jsonPost?: boolean
  httpErrors?: boolean
}

const options: Record<string, Omit<Endpoint, 'handler'>> = {
  getOpenSubsonicExtensions: { public: true },
  startScan: { admin: true },
  getTranscodeDecision: { jsonPost: true },
  getTranscodeStream: { httpErrors: true },
}

const handlers: Record<string, Handler> = {
  ...systemEndpoints,
  ...browsingEndpoints,
  ...listEndpoints,
  ...searchEndpoints,
  ...mediaEndpoints,
  ...negotiationEndpoints,
  ...sonicEndpoints,
  ...annotationEndpoints,
  ...playlistEndpoints,
  ...queueEndpoints,
}

/** The method names implemented, as the specification spells them. */
export const methodNames = Object.keys(handlers)

export const endpoints = new Map<string, Endpoint>(
  Object.entries(handlers).map(([name, handler]) => [name.toLowerCase(), { handler, ...options[name] }]),
)
