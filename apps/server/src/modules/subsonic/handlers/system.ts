/** System, user and scanning endpoints, plus empty answers for features Squirmy does not have. */
import { eq, sql } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { users } from '../../../database/schema.js'
import { usernameKey } from '../../auth/service.js'
import { listRoots, requestScan } from '../../library/roots.js'
import { musicFolders } from '../folders.js'
import { notAuthorized, notFound, type Context, type Handler, type Payload } from '../protocol.js'

/** Every extension implemented here, with its versions. */
export const extensions = [
  { name: 'apiKeyAuthentication', versions: [1] },
  { name: 'formPost', versions: [1] },
  { name: 'indexBasedQueue', versions: [1] },
  { name: 'playbackReport', versions: [1] },
  { name: 'songLyrics', versions: [1, 2] },
  { name: 'sonicSimilarity', versions: [1] },
  { name: 'topSongsByArtistId', versions: [1] },
  { name: 'transcodeOffset', versions: [1] },
  { name: 'transcoding', versions: [1] },
]

async function scanStatus(): Promise<Payload> {
  const [roots, [files]] = await Promise.all([
    listRoots(),
    db.execute<{ waiting: number; done: number }>(sql`
      select count(*) filter (where probe_stage = 0 and probe_error is null)::int as waiting,
        count(*) filter (where probe_stage > 0)::int as done
      from media_files where missing_since is null`),
  ])
  return { scanStatus: { scanning: roots.some((root) => root.scanning) || (files?.waiting ?? 0) > 0, count: files?.done ?? 0 } }
}

async function getUser({ user, params }: Context): Promise<Payload> {
  const username = params.required('username')
  if (usernameKey(username) !== user.usernameKey && user.role !== 'admin') throw notAuthorized()
  const [row] = await db.select().from(users).where(eq(users.usernameKey, usernameKey(username)))
  if (!row) throw notFound('User')
  const admin = row.role === 'admin'
  return {
    user: {
      username: row.username,
      scrobblingEnabled: true,
      adminRole: admin,
      settingsRole: admin,
      downloadRole: true,
      uploadRole: row.canUpload,
      playlistRole: true,
      coverArtRole: true,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
      videoConversionRole: false,
      folder: (await musicFolders()).map((folder) => folder.id),
    },
  }
}

export const systemEndpoints: Record<string, Handler> = {
  ping: async () => ({}),
  getLicense: async () => ({ license: { valid: true } }),
  getOpenSubsonicExtensions: async () => ({ openSubsonicExtensions: extensions }),
  tokenInfo: async ({ user }) => ({ tokenInfo: { username: user.username } }),
  getUser,
  getMusicFolders: async () => ({
    musicFolders: { musicFolder: (await musicFolders()).map((folder) => ({ id: folder.id, name: folder.name })) },
  }),
  getScanStatus: scanStatus,
  startScan: async () => {
    const roots = await listRoots()
    for (const root of roots) if (root.enabled) await requestScan(root.id)
    return { scanStatus: { ...(await scanStatus()).scanStatus as Payload, scanning: roots.some((root) => root.enabled) } }
  },

  // Squirmy has no podcasts, radio stations, bookmarks or shares. Clients ask for them
  // at startup, so they get empty lists rather than errors.
  getPodcasts: async () => ({ podcasts: { channel: [] } }),
  getNewestPodcasts: async () => ({ newestPodcasts: { episode: [] } }),
  getInternetRadioStations: async () => ({ internetRadioStations: { internetRadioStation: [] } }),
  getBookmarks: async () => ({ bookmarks: { bookmark: [] } }),
  getShares: async () => ({ shares: { share: [] } }),
}
