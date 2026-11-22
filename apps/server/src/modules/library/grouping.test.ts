import { describe, expect, it } from 'vitest'
import type { FileTags } from '../../database/schema.js'
import { albumFolder, creditText, groupKeyFor, parseCredits, planGroup, VARIOUS_ARTISTS_MBID, type GroupFile } from './grouping.js'

const root = 'root-1'
let counter = 0
const file = (relPath: string, tags: FileTags): GroupFile => ({ id: `f${++counter}`, relPath, tags, durationMs: 1000 })

describe('parseCredits', () => {
  it('splits featured artists with their join phrase', () => {
    expect(parseCredits('Daft Punk feat. Pharrell Williams & Nile Rodgers')).toEqual([
      { name: 'Daft Punk', joinPhrase: ' feat. ' },
      { name: 'Pharrell Williams & Nile Rodgers', joinPhrase: '' },
    ])
    expect(creditText(parseCredits('A (featuring B)'))).toBe('A featuring B')
    expect(parseCredits('A ft B feat. C').map((credit) => credit.name)).toEqual(['A', 'B', 'C'])
    expect(parseCredits('A [Feat. B]')).toEqual([{ name: 'A', joinPhrase: ' feat. ' }, { name: 'B', joinPhrase: '' }])
  })

  it('never splits on &, comma or slash', () => {
    for (const name of ['Simon & Garfunkel', 'Earth, Wind & Fire', 'AC/DC', 'Featherstone', 'Daft. Punk']) {
      expect(parseCredits(name)).toEqual([{ name, joinPhrase: '' }])
    }
  })

  it('uses a multi-value artists tag and reads join phrases from the display string', () => {
    expect(parseCredits('Daft Punk feat. Pharrell Williams & Nile Rodgers', ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'])).toEqual([
      { name: 'Daft Punk', joinPhrase: ' feat. ' },
      { name: 'Pharrell Williams', joinPhrase: ' & ' },
      { name: 'Nile Rodgers', joinPhrase: '' },
    ])
    expect(creditText(parseCredits('something else', ['A', 'B', 'C']))).toBe('A, B & C')
  })

  it('attaches MusicBrainz ids by position', () => {
    expect(parseCredits('A feat. B', undefined, ['id-a', 'id-b']).map((credit) => credit.mbid)).toEqual(['id-a', 'id-b'])
    expect(parseCredits('A', undefined, ['id-a']).map((credit) => credit.mbid)).toEqual(['id-a'])
    expect(parseCredits('A feat. B', undefined, ['id-a']).map((credit) => credit.mbid)).toEqual([undefined, undefined])
  })
})

describe('group keys', () => {
  it('folds disc folders into the album folder', () => {
    for (const disc of ['CD1', 'cd 2', 'Disc 2', 'disk3', 'DISC_04', 'CD1 - Bonus', 'Disc 2: Live']) {
      expect(albumFolder(`Artist/Album/${disc}/01.flac`).dir).toBe('Artist/Album')
    }
    expect(albumFolder('Artist/Album/Disc 2/01.flac').disc).toBe(2)
    expect(albumFolder('Artist/CD Collection/01.flac')).toEqual({ dir: 'Artist/CD Collection' })
    expect(albumFolder('Discography/01.flac')).toEqual({ dir: 'Discography' })
    expect(albumFolder('CD1/01.flac')).toEqual({ dir: '', disc: 1 })
    expect(albumFolder('loose.flac')).toEqual({ dir: '' })
  })

  it('keys tagged files by folder, album artist and album', () => {
    const tags = { album: 'The Wall', albumArtist: 'Pink Floyd', artist: 'Pink Floyd' }
    const cd1 = groupKeyFor(root, 'Pink Floyd/The Wall/CD1/01.flac', tags)
    expect(cd1).toBe('root-1|Pink Floyd/The Wall|pink floyd|the wall')
    expect(groupKeyFor(root, 'Pink Floyd/The Wall/CD2/01.flac', { ...tags, disc: 2 })).toBe(cd1)
    // Same album name in another folder is another album; so is another album name in one folder.
    expect(groupKeyFor(root, 'Elsewhere/01.flac', tags)).not.toBe(cd1)
    expect(groupKeyFor(root, 'Pink Floyd/The Wall/CD1/02.flac', { ...tags, album: 'The Wall (Live)' })).not.toBe(cd1)
    // Case, accents and punctuation do not split a group.
    expect(groupKeyFor(root, 'Pink Floyd/The Wall/CD1/03.flac', { album: 'THE WALL!', albumArtist: 'pink floyd' })).toBe(cd1)
  })

  it('keeps an untagged compilation in one group whatever the track artists', () => {
    const a = groupKeyFor(root, 'Mixes/Summer/01.flac', { album: 'Summer', artist: 'Alpha' })
    expect(groupKeyFor(root, 'Mixes/Summer/02.flac', { album: 'Summer', artist: 'Beta feat. Gamma' })).toBe(a)
  })

  it('groups loose files by folder and artist, and lone untagged files alone', () => {
    const karma = groupKeyFor(root, 'misc/02 - Karma Police.mp3', { title: 'Karma Police', artist: 'Radiohead' })
    expect(karma).toBe('root-1|misc|radiohead|')
    expect(groupKeyFor(root, 'misc/03.mp3', { artist: 'Radiohead feat. Someone' })).toBe(karma)
    expect(groupKeyFor(root, 'misc/04.mp3', { artist: 'Muse' })).not.toBe(karma)
    expect(groupKeyFor(root, 'misc/track01.mp3', {})).toBe('root-1|file:misc/track01.mp3')
    expect(groupKeyFor(root, 'misc/track02.mp3', { album: '???' })).toBe('root-1|file:misc/track02.mp3')
  })
})

describe('planGroup', () => {
  it('takes the album artist tag when present', () => {
    const plan = planGroup([
      file('A/X/01.flac', { album: 'X', albumArtist: 'Daft Punk', artist: 'Daft Punk feat. Someone', track: 1, compilation: true }),
      file('A/X/02.flac', { album: 'X', albumArtist: 'Daft Punk', artist: 'Other', track: 2 }),
    ])
    expect(plan.album.credits).toEqual([{ name: 'Daft Punk', joinPhrase: '' }])
    expect(plan.album.type).toBe('compilation')
    expect(plan.tracks.map((track) => creditText(track.credits))).toEqual(['Daft Punk feat. Someone', 'Other'])
  })

  it('credits the artists of an album artist tag that runs a track\'s artists together', () => {
    // A provider that writes the track artists joined by commas as the album artist, with a
    // multi-value artists tag that names them.
    const plan = planGroup([file('X/01.flac', { album: 'HOTLIFE', albumArtist: 'Tiga, Fcukers', artist: 'Tiga, Fcukers', artists: ['Tiga', 'Fcukers'], track: 4 })])
    expect(plan.album.credits.map((credit) => credit.name)).toEqual(['Tiga', 'Fcukers'])
    expect(creditText(plan.album.credits)).toBe('Tiga, Fcukers')
    // Without names to split by, a comma stays part of the name.
    expect(planGroup([file('Y/01.flac', { album: 'Y', albumArtist: 'Earth, Wind & Fire', artist: 'Earth, Wind & Fire' })]).album.credits)
      .toEqual([{ name: 'Earth, Wind & Fire', joinPhrase: '' }])
  })

  it('uses the track artist when every track agrees, at least on the main artist', () => {
    const same = planGroup([file('X/01.flac', { album: 'X', artist: 'Muse' }), file('X/02.flac', { album: 'X', artist: 'muse' })])
    expect(same.album.credits).toEqual([{ name: 'Muse', joinPhrase: '' }])
    const featuring = planGroup([file('X/01.flac', { album: 'X', artist: 'Muse' }), file('X/02.flac', { album: 'X', artist: 'Muse feat. Guest' })])
    expect(featuring.album.credits).toEqual([{ name: 'Muse', joinPhrase: '' }])
    expect(featuring.album.type).toBe('album')
  })

  it('falls back to Various Artists for disagreeing tracks or a compilation flag', () => {
    const mixed = planGroup([file('X/01.flac', { album: 'X', artist: 'A' }), file('X/02.flac', { album: 'X', artist: 'B' })])
    expect(mixed.album.credits).toEqual([{ name: 'Various Artists', joinPhrase: '', mbid: VARIOUS_ARTISTS_MBID }])
    expect(mixed.album.type).toBe('compilation')
    const flagged = planGroup([file('X/01.flac', { album: 'X', artist: 'A', compilation: true })])
    expect(flagged.album.credits[0]!.name).toBe('Various Artists')
    expect(planGroup([file('X/01.flac', { album: 'X', albumArtist: 'various artists' })]).album.credits[0]!.mbid).toBe(VARIOUS_ARTISTS_MBID)
  })

  it('takes the type a release-type tag states, and marks the default as a guess', () => {
    // A provider delivery: the single "you broke me first", tagged with its album name.
    const single = planGroup([file('Tate McRae - you broke me first/1-01 you broke me first.m4a', {
      title: 'you broke me first', artist: 'Tate McRae', album: 'you broke me first', releaseType: 'single',
    })])
    expect(single.album).toMatchObject({ type: 'single', typeGuessed: false })
    const untyped = planGroup([file('Tate McRae - you broke me first/1-01 you broke me first.m4a', { title: 'you broke me first', artist: 'Tate McRae', album: 'you broke me first' })])
    expect(untyped.album).toMatchObject({ type: 'album', typeGuessed: true })
    const compilation = planGroup([file('Hits/01.flac', { title: 'A', artist: 'X', album: 'Hits', compilation: true })])
    expect(compilation.album).toMatchObject({ type: 'compilation', typeGuessed: false })
  })

  it('names synthetic albums after the folder and singles after the track', () => {
    const loose = planGroup([file('Demos/a.ogg', { title: 'A', artist: 'Lune' }), file('Demos/b.ogg', { title: 'B', artist: 'Lune' })])
    expect(loose.album).toMatchObject({ title: 'Demos', type: 'album' })
    const single = planGroup([file('misc/02 - Karma Police.mp3', { artist: 'Radiohead' })])
    expect(single.album).toMatchObject({ title: 'Karma Police', type: 'single' })
    expect(single.tracks[0]!.title).toBe('Karma Police')
    expect(planGroup([file('misc/track01.mp3', {})]).album.credits).toEqual([{ name: 'Unknown Artist', joinPhrase: '' }])
  })

  it('places tracks by disc and number, sharing a slot between copies and moving clashes to the end', () => {
    const plan = planGroup([
      file('X/CD2/01.flac', { album: 'X', title: 'Two One', track: 1 }),
      file('X/CD1/01.flac', { album: 'X', title: 'One One', track: 1 }),
      file('X/CD1/01 copy.mp3', { album: 'X', title: 'One One', track: 1 }),
      file('X/CD1/01 other.flac', { album: 'X', title: 'Clash', track: 1 }),
      file('X/CD1/zz.flac', { album: 'X', title: 'No Number' }),
      file('X/CD1/02.flac', { album: 'X', title: 'One Two', track: 2, disc: 1 }),
    ])
    expect(plan.tracks.map((track) => [track.disc, track.position, track.title])).toEqual([
      [1, 1, 'One One'], [1, 1, 'One One'], [1, 2, 'One Two'], [1, 3, 'Clash'], [1, 4, 'No Number'], [2, 1, 'Two One'],
    ])
    expect(plan.release.discCount).toBe(2)
  })

  it('collects album and release facts from the most common values', () => {
    const plan = planGroup([
      file('X/01.flac', { album: 'X', year: 2013, date: '2013-05-17', genres: ['Electronic'], label: 'Columbia', barcode: '886443927087', mbReleaseId: 'r1' }),
      file('X/02.flac', { album: 'X', year: 2013, date: '2013', genres: ['electronic', 'Disco'], label: 'Columbia', mbReleaseId: 'r1' }),
      file('X/03.flac', { album: 'x', year: 2014, genres: ['Disco'], label: 'Other' }),
    ])
    expect(plan.album).toMatchObject({ title: 'X', year: 2013, date: '2013-05-17', genres: ['Electronic', 'Disco'] })
    expect(plan.release).toMatchObject({ label: 'Columbia', barcode: '886443927087', mbReleaseId: 'r1', discCount: 1 })
  })
})
