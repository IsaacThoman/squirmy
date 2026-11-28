import type { ArtistRef, CreditRole, TrackCredit } from '@squirmy/contracts'

/** A run of a credit's text, and the artist it names when it is one. */
export type CreditPart = { text: string; artist: ArtistRef | null }

/**
 * A credit split into the artists it names and the words between them, for showing each
 * artist as a link: "Thundercat feat. Tame Impala" with both artists gives Thundercat,
 * " feat. ", Tame Impala. Every surface shows the credit's own wording (its join phrases,
 * "feat.", "&"), so a row, the player and a card read the same.
 *
 * The artists are looked for in order, ignoring case, as whole words (Ye is not found in
 * Yeat). One the credit does not name as such is left out of the links, and the text stays as
 * credited. A credit that names none of them is all one link for a lone artist; for several,
 * and for an empty credit, it is spelled from the artists: their names joined with ", " and a
 * final " & ".
 */
export function creditParts(credit: string, artists: readonly ArtistRef[]): CreditPart[] {
  if (!credit.trim()) return joinedNames(artists)
  const parts: CreditPart[] = []
  const lower = credit.toLocaleLowerCase()
  let cursor = 0
  for (const artist of artists) {
    const name = artist.name.trim()
    if (!name) continue
    const at = findName(lower, name.toLocaleLowerCase(), cursor)
    if (at < 0) continue
    if (at > cursor) parts.push({ text: credit.slice(cursor, at), artist: null })
    parts.push({ text: credit.slice(at, at + name.length), artist })
    cursor = at + name.length
  }
  if (!parts.some(part => part.artist)) {
    // A lone artist credited under another spelling ("JAY Z" for JAY-Z) is still the whole credit.
    if (artists.length === 1) return [{ text: credit, artist: artists[0]! }]
    if (artists.length) return joinedNames(artists)
  }
  if (cursor < credit.length) parts.push({ text: credit.slice(cursor), artist: null })
  return parts
}

function joinedNames(artists: readonly ArtistRef[]): CreditPart[] {
  return artists.flatMap((artist, index) => [
    ...(index === 0 ? [] : [{ text: index === artists.length - 1 ? ' & ' : ', ', artist: null }]),
    { text: artist.name, artist },
  ])
}

const WORD = /[\p{L}\p{N}]/u

/** Where `name` next stands as a whole word in `text` from `from`, or -1. */
function findName(text: string, name: string, from: number): number {
  for (let at = text.indexOf(name, from); at >= 0; at = text.indexOf(name, at + 1)) {
    const before = text[at - 1]
    const after = text[at + name.length]
    // A name that itself ends in punctuation ("!!!", "Sunn O)))") bounds itself.
    const startsWord = WORD.test(name.at(0) ?? '') && WORD.test(before ?? '')
    const endsWord = WORD.test(name.at(-1) ?? '') && WORD.test(after ?? '')
    if (!startsWord && !endsWord) return at
  }
  return -1
}

/** What each credit role is called, as a heading over the artists who had it. */
export const creditRoleLabels: Record<CreditRole, string> = {
  composer: 'Composer',
  lyricist: 'Lyricist',
  conductor: 'Conductor',
  arranger: 'Arranger',
  producer: 'Producer',
  engineer: 'Engineer',
  mixer: 'Mixer',
  remixer: 'Remixer',
  performer: 'Performer',
  ensemble: 'Ensemble',
}

/** One role of a track's credits and who had it, each named with their instrument when there is one. */
export type CreditGroup = { role: CreditRole; label: string; credits: { artist: ArtistRef; name: string }[] }

/** A track's credits grouped by role, in the order the roles first appear. */
export function creditGroups(credits: readonly TrackCredit[] | undefined): CreditGroup[] {
  const groups = new Map<CreditRole, CreditGroup>()
  for (const { artist, role, instrument } of credits ?? []) {
    const group = groups.get(role) ?? { role, label: creditRoleLabels[role], credits: [] }
    group.credits.push({ artist, name: instrument ? `${artist.name} · ${instrument}` : artist.name })
    groups.set(role, group)
  }
  return [...groups.values()]
}
