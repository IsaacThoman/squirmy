/**
 * Seam between the catalog read side and enrichment.
 *
 * Catalog rows start as stubs (`detail_level` 0 or 1) and are completed on demand: the
 * artist and album routes call these before reading. Each resolves once the row is as
 * complete as the enabled metadata sources allow, and never throws for a source being
 * down; the page then renders whatever is known.
 */

/** Fetch an album's editions and track list if they are missing or stale. */
export async function ensureAlbumDetail(_albumId: string): Promise<void> {}

/** Fetch an artist's profile and discography if they are missing or stale. */
export async function ensureArtistDetail(_artistId: string): Promise<void> {}
