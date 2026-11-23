import { describe, expect, it } from 'vitest'
import { identifyTrack, type TrackRef } from './track-identity.js'

const track = (id: string, title: string, isrcs: string[], durationMs: number | null, position: number | null): TrackRef =>
  ({ id, title, isrcs, durationMs, disc: position === null ? null : 1, position })

// The canonical release of ADÉLA's PRIMA as the test instance had it (the Dolby Atmos mix,
// codes of its own), and Deezer's explicit album with the stereo codes.
const album = [
  track('kgb', 'KGB', ['USUM72601923'], 158000, 1),
  track('nicole', 'Nicole Kidman', ['USUM72607794'], 181000, 2),
  track('man', 'I’m the Man', ['USUM72607788'], 150000, 3),
  track('boys', 'Boys', ['USUM72607783'], 145000, 4),
  track('red', 'Red Bottoms', ['USUM72604715'], 187000, 5),
]

describe('identifyTrack', () => {
  it('takes a shared ISRC first', () => {
    expect(identifyTrack(track('x', 'Nicole Kidman', ['USUM72607794'], 181317, null), album)?.id).toBe('nicole')
  })

  it('matches a title written another way at the same place, whatever its code', () => {
    expect(identifyTrack(track('x', "I'm The Man", ['USUM72606033'], 150498, 3), album)?.id).toBe('man')
    expect(identifyTrack(track('x', 'KGB (feat. Nobody)', ['USUM72601922'], 157363, 1), album)?.id).toBe('kgb')
  })

  it('keeps apart a title with other codes and no place in common: a live take or a re-recording', () => {
    expect(identifyTrack(track('x', 'Boys', ['GBXXX0000001'], 146000, null), album)).toBeNull()
    // Without codes on one side, title and length do.
    expect(identifyTrack(track('x', 'Boys', [], 146000, null), album)?.id).toBe('boys')
    expect(identifyTrack(track('x', 'Boys', [], 160000, null), album)).toBeNull()
  })

  it('needs a title or a place with an ISRC unless the ISRC may count alone', () => {
    const renamed = track('x', 'Something Else', ['USUM72604715'], 187000, 9)
    expect(identifyTrack(renamed, album)).toBeNull()
    expect(identifyTrack(renamed, album, { isrcAlone: true })?.id).toBe('red')
  })

  it('takes the place and a close length when the titles differ, unless the title is listed elsewhere or names another version', () => {
    expect(identifyTrack(track('x', 'Rote Sohlen', ['DE0000000001'], 186500, 5), album)?.id).toBe('red')
    expect(identifyTrack(track('x', 'Rote Sohlen', ['DE0000000001'], 183000, 5), album)).toBeNull()
    // A deluxe edition in another order: Red Bottoms is on it, elsewhere.
    expect(identifyTrack(track('x', 'Rote Sohlen', [], 186500, 5), album, { titles: new Set(['red bottoms']) })).toBeNull()
    expect(identifyTrack(track('x', 'Red Bottoms (Live)', [], 186500, 5), album)).toBeNull()
  })

  // Cases the album repair met on the test instance.
  it('keeps apart songs whose lengths disagree, whatever their titles and codes say', () => {
    // Deezer lists the 1971 "Baby" on Os Mutantes' 1968 album with the same code.
    const mutantes = [track('baby', 'Baby', ['BRPGD7100028'], 180000, 5)]
    expect(identifyTrack(track('x', 'Baby', ['BRPGD7100028'], 217000, 5), mutantes)).toBeNull()
    // PinkPantheress's "Nice to meet you" and the version with Central Cee.
    const heaven = [track('nice', 'Nice to meet you', ['GBAYE2301420'], 123373, 5)]
    expect(identifyTrack(track('x', 'Nice to meet you (feat. Central Cee)', ['GBAYE2301689'], 162000, 5), heaven)).toBeNull()
    // A shared code and title with a store's rounding still match.
    expect(identifyTrack(track('x', 'Shiva-Loka', ['USMC17052077'], 392000, 2), [track('shiva', 'Shiva‐Loka', ['USMC17052077'], 397626, 2)])?.id).toBe('shiva')
  })

  it('does not take a place whose song the other list has elsewhere', () => {
    // DAMN.'s collector's edition runs in reverse: FEEL. sits where the album has LOVE.
    const damn = [track('love', 'LOVE.', ['USUM71703088'], 213400, 10)]
    const feel = track('x', 'FEEL.', ['USUM71703082'], 214000, 10)
    expect(identifyTrack(feel, damn, { titles: new Set(['feel', 'love']) })).toBeNull()
  })

  it('names nothing when two tracks fit equally', () => {
    const twice = [track('a', 'Intro', [], 60000, 1), { ...track('b', 'Intro', [], 61000, 1), disc: 2 }]
    expect(identifyTrack(track('x', 'Intro', [], 60500, null), twice)).toBeNull()
    expect(identifyTrack(track('x', 'Intro', [], 60500, 1), twice)?.id).toBe('a')
  })
})
