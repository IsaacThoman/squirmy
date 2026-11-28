/**
 * Seam for similarity by sound: how alike artists sound, from analysis of the audio itself
 * (features or embeddings of the files), which radio and the mixes can use once it exists.
 *
 * `artistSoundAffinity` answers, for pairs of the given artists, a similarity from 0 (nothing
 * alike) to 1 (alike), keyed by `pairKey`; a pair it cannot judge is left out. Mixes blend it
 * with the genre, similar-artist and co-listening signals they already use (mixes.ts
 * `affinity`). Until the analysis lands it answers null, and mixes are made from the other
 * signals alone. The module that owns the analysis fills this in; callers never change.
 */
export async function artistSoundAffinity(artistIds: readonly string[]): Promise<Map<string, number> | null> {
  void artistIds
  return null
}

/** The key of an unordered pair of ids. */
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
