import { describe, expect, it } from 'vitest'
import { editionFreeKey, editionFreeTitle, guessAlbumType, prefixEnd, releaseKey } from './keys.js'

describe('editionFreeTitle', () => {
  it('drops edition suffixes in brackets or after a dash', () => {
    expect(editionFreeTitle('OK Computer (Deluxe Edition)')).toBe('OK Computer')
    expect(editionFreeTitle('Abbey Road (Remastered 2019)')).toBe('Abbey Road')
    expect(editionFreeTitle('Let It Be - Remastered 2009')).toBe('Let It Be')
    expect(editionFreeTitle('Nevermind (30th Anniversary Super Deluxe)')).toBe('Nevermind')
    expect(editionFreeTitle('Nevermind [Deluxe Edition] (Explicit)')).toBe('Nevermind')
    expect(editionFreeTitle('Fauxllennium (Japanese Deluxe Edition)')).toBe('Fauxllennium')
    expect(editionFreeTitle('Kid A (Japan)')).toBe('Kid A (Japan)')
    expect(editionFreeTitle("Rumours (Collector's Edition)")).toBe('Rumours')
    expect(editionFreeTitle('Thriller – Special Edition')).toBe('Thriller')
  })

  it('drops guest credits', () => {
    expect(editionFreeTitle('Get Lucky (feat. Pharrell Williams and Nile Rodgers)')).toBe('Get Lucky')
    expect(editionFreeTitle('Song [ft. Someone] (Remastered)')).toBe('Song')
    expect(editionFreeTitle('Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)')).toBe('Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)')
  })

  it('keeps suffixes that name different music', () => {
    for (const title of [
      'Nevermind (Live at the Paramount)', 'Help! (Remixes)', 'Karma Police (Radio Edit)', "1989 (Taylor's Version)",
      'Unplugged (Acoustic)', 'Abbey Road Sessions', 'OK Computer OKNOTOK 1997 2017', 'Pet Sounds (Mono)', 'Song (2011)',
    ]) expect(editionFreeTitle(title)).toBe(title)
  })

  it('keeps edition words that are the title itself', () => {
    expect(editionFreeTitle('Squeaky Clean')).toBe('Squeaky Clean')
    expect(editionFreeTitle('(Deluxe)')).toBe('(Deluxe)')
    expect(editionFreeTitle('Remastered')).toBe('Remastered')
  })

  it('compares as match keys', () => {
    expect(editionFreeKey('OK, Computer! (Deluxe Edition)')).toBe('ok computer')
    expect(editionFreeKey('Ágætis byrjun (Remastered)')).toBe('agaetis byrjun')
  })
})

describe('prefixEnd', () => {
  it('bounds every string with the prefix', () => {
    expect(prefixEnd('abc')).toBe('abd')
    expect('abc zzz' < prefixEnd('abc') && 'abd' >= prefixEnd('abc')).toBe(true)
    expect(prefixEnd('東京')).toBe('東亭')
  })
})

describe('releaseKey', () => {
  it('drops store labels of what a release is or where it comes from', () => {
    expect(releaseKey('Just Keep Watching (From F1® The Movie)')).toBe(releaseKey('Just Keep Watching'))
    expect(releaseKey('TRON: Legacy (Original Motion Picture Soundtrack)')).toBe(releaseKey('TRON: Legacy'))
    expect(releaseKey('Dune: Part Two: Original Motion Picture Soundtrack')).toBe(releaseKey('Dune: Part Two (Original Motion Picture Soundtrack)'))
    expect(releaseKey('Dune: Original Motion Picture Soundtrack')).toBe('dune')
    expect(releaseKey('Inception: Music From the Motion Picture')).toBe(releaseKey('Inception (Music from the Motion Picture)'))
    expect(releaseKey('Stereotype E.P.')).toBe('stereotype')
    expect(releaseKey('Spectre - Single')).toBe('spectre')
    expect(releaseKey('Miss Anthropocene (Deluxe Edition)')).toBe('miss anthropocene')
  })

  it('keeps what names different music', () => {
    expect(releaseKey('Miss Anthropocene (rave edition)')).not.toBe(releaseKey('Miss Anthropocene'))
    expect(releaseKey('Sports car (remixes)')).not.toBe(releaseKey('Sports car'))
    expect(releaseKey('Realiti (Demo)')).not.toBe(releaseKey('Realiti'))
    // Nothing is left of a title that is only a label.
    expect(releaseKey('EP')).toBe('ep')
  })
})

describe('guessAlbumType', () => {
  it('calls an album titled like its track a single', () => {
    expect(guessAlbumType('exes', ['exes'])).toBe('single')
    expect(guessAlbumType('Just Keep Watching (From F1® The Movie)', ['Just Keep Watching (From F1® The Movie)'])).toBe('single')
    expect(guessAlbumType('THINK LATER', ['exes'])).toBe('album')
    expect(guessAlbumType('Sports car', [])).toBe('album')
  })
})
