/** Tries to get the track list of an album the server is still filling in, about 2 s apart. */
const expandRetries = 5;

/**
 * Whether an album's page should wait for its track list rather than show it empty. An
 * album the server has only heard of (from search or a discography) first comes back with
 * no tracks while the server looks them up; a later answer has them. `answers` counts the
 * answers so far, so a genuinely empty album stops being asked for.
 */
export function albumExpanding(album: { trackCount: number; discs: readonly unknown[] } | undefined, answers: number): boolean {
  return album !== undefined && album.trackCount === 0 && album.discs.length === 0 && answers <= expandRetries;
}
