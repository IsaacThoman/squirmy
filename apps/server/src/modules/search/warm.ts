/**
 * Background album detail for catalog search results. A stub album from a provider has no
 * track list until its detail is fetched, and until then it is gray and its page waits for
 * providers. Fetching the first few as soon as they are found means the ones a user is
 * likely to open are complete by the time they do, without making the search wait.
 */
import { getConfig } from '../../config.js'
import { albumDetailRun } from '../enrichment/detail.js'

/** Albums warmed per search: the first ones listed, which are the ones people open. */
const warmedPerSearch = 5
/** Runs at once across all searches; each mostly waits on MusicBrainz's one request a second. */
const concurrency = 2

const running = new Set<string>()
let waiting: string[] = []
let warmInTests = false

/** Tests turn warming on where they replace what a run calls; otherwise it would reach providers. */
export function setAlbumWarming(enabled: boolean) {
  warmInTests = enabled
}

/**
 * Starts completing the detail of up to `warmedPerSearch` of `albumIds`, at most
 * `concurrency` at a time, without waiting. A newer search's albums go ahead of what an
 * older one left waiting, and push out the oldest, so typing a few queries in a row cannot
 * pile up provider calls for results nobody is looking at any more. Joins a run a page
 * already started (runs are shared per album); never throws.
 */
export function warmAlbums(albumIds: readonly string[]) {
  if (getConfig().NODE_ENV === 'test' && !warmInTests) return
  const fresh = [...new Set(albumIds)].slice(0, warmedPerSearch).filter((id) => !running.has(id))
  waiting = [...fresh, ...waiting.filter((id) => !fresh.includes(id))].slice(0, warmedPerSearch)
  startWaiting()
}

function startWaiting() {
  while (running.size < concurrency && waiting.length > 0) {
    const albumId = waiting.shift()!
    running.add(albumId)
    void albumDetailRun(albumId)
      .catch((error: unknown) => {
        if (getConfig().LOG_LEVEL !== 'silent') console.warn(`[search] Warming album ${albumId} failed`, error)
      })
      .finally(() => {
        running.delete(albumId)
        startWaiting()
      })
  }
}
