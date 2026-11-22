import { describe, expect, it } from 'vitest'
import { fansPopularity, isCreditLine } from './providers.js'
import { rank, topOf, type RankInput, type RankSignals } from './rank.js'

/**
 * Answers shaped like Deezer's for real queries: names as Deezer writes them, fan counts and
 * song ranks rounded from what it reported, each list in Deezer's own order.
 */
type Fixture = { inputs: RankInput[]; signals: RankSignals }

function fixture() {
  const inputs: RankInput[] = []
  const popularity = new Map<string, number>()
  const counts = { artist: 0, album: 0, track: 0 }
  const add = (input: Omit<RankInput, 'position'>, value: number | null) => {
    inputs.push({ ...input, position: counts[input.type]++ })
    if (value !== null) popularity.set(input.id, value)
  }
  const build = {
    artist(id: string, name: string, fans: number) {
      add({ type: 'artist', id, name, artistCredit: null, artistNames: [], artistIds: [], albumId: null }, fansPopularity(fans))
      return build
    },
    album(id: string, title: string, by: [id: string, name: string], albumType: RankInput['albumType'] = 'album') {
      add({ type: 'album', id, name: title, artistCredit: by[1], artistNames: [by[1]], artistIds: [by[0]], albumId: null, albumType }, null)
      return build
    },
    /** `rank` is Deezer's, which reaches about a million for the most played songs. */
    track(id: string, title: string, by: [id: string, name: string], rank: number, albumId: string | null = null) {
      add({ type: 'track', id, name: title, artistCredit: by[1], artistNames: [by[1]], artistIds: [by[0]], albumId }, rank / 1_000_000)
      return build
    },
    done: (): Fixture => ({ inputs, signals: { popularity, owned: new Set(), plays: new Map(), liked: new Set() } }),
  }
  return build
}

const order = (query: string, { inputs, signals }: Fixture) => rank(query, inputs, signals).map((item) => item.id)
const top = (query: string, { inputs, signals }: Fixture) => topOf(rank(query, inputs, signals))

describe('rank', () => {
  it('puts a far more prominent prefix match above an obscure exact name (tate)', () => {
    const mcrae = ['tate-mcrae', 'Tate McRae'] as [string, string]
    const answer = fixture()
      .artist('tate-mcrae', 'Tate McRae', 2_100_000).artist('t.a.t.e', 'T.A.T.E', 1_500).artist('tate', 'TATE', 3_000).artist('fate', 'Fate', 12_000)
      .album('think-later', 'THINK LATER', mcrae).album('so-close', 'So Close to What', mcrae)
      .track('greedy', 'greedy', mcrae, 870_000, 'think-later').track('exes', 'exes', mcrae, 640_000, 'think-later')
      .done()
    const list = order('tate', answer)
    expect(list[0]).toBe('tate-mcrae')
    // The exact name still comes before what only matches through its artist.
    expect(list.indexOf('tate')).toBeLessThan(list.indexOf('think-later'))
    expect(list.indexOf('t.a.t.e')).toBeLessThan(list.indexOf('greedy'))
    expect(list.at(-1)).toBe('fate')
    expect(top('tate', answer)).toEqual({ type: 'artist', id: 'tate-mcrae', score: 1 })
  })

  it('never buries an exact name under a famous artist\'s songs found through the artist alone', () => {
    const mcrae = ['tate-mcrae', 'Tate McRae'] as [string, string]
    const build = fixture().artist('tate-mcrae', 'Tate McRae', 2_100_000).artist('tate', 'TATE', 120)
    for (let n = 0; n < 12; n++) build.track(`song-${n}`, `Song ${n}`, mcrae, 950_000 - n * 10_000)
    const list = order('tate', build.done())
    expect(list.slice(0, 2)).toEqual(['tate-mcrae', 'tate'])
  })

  it('lists an artist found by name, then their music, then near misses (mgmt)', () => {
    const mgmt = ['mgmt', 'MGMT'] as [string, string]
    const answer = fixture()
      .artist('mgmt', 'MGMT', 1_400_000).artist('magma', 'Magma', 40_000).artist('lgm', 'LGM', 2_000)
      .album('oracular', 'Oracular Spectacular', mgmt).album('little-dark-age', 'Little Dark Age', mgmt).album('loss-of-life', 'Loss of Life', mgmt)
      .track('electric-feel', 'Electric Feel', mgmt, 810_000, 'oracular').track('kids', 'Kids', mgmt, 790_000, 'oracular')
      .track('ldage', 'Little Dark Age', mgmt, 760_000, 'little-dark-age')
      .done()
    const list = order('mgmt', answer)
    expect(list[0]).toBe('mgmt')
    // An album is at least as known as its best known song found.
    expect(list.indexOf('oracular')).toBeLessThan(list.indexOf('electric-feel'))
    expect(list.slice(-2).sort()).toEqual(['lgm', 'magma'])
    expect(top('mgmt', answer)).toEqual({ type: 'artist', id: 'mgmt', score: 3 })
  })

  it('keeps an exact name of similar prominence above a prefix match (grimes, drake, glass)', () => {
    const grimes = fixture().artist('grimes-io', 'Grimes & i_o', 5_000).artist('grimes', 'Grimes', 1_000_000)
      .track('genesis', 'Genesis', ['grimes', 'Grimes'], 700_000).done()
    expect(order('grimes', grimes)[0]).toBe('grimes')
    expect(order('drake', fixture().artist('drake-bell', 'Drake Bell', 600_000).artist('drake', 'Drake', 30_000_000).done())[0]).toBe('drake')
    expect(order('glass', fixture().artist('glass-animals', 'Glass Animals', 150_000).artist('glass', 'Glass', 100_000).done())[0]).toBe('glass')
  })

  it('reads a leading article either way (the strokes)', () => {
    const answer = fixture()
      .artist('tribute', 'The Strokes Tribute Band', 200).artist('strokes', 'The Strokes', 1_500_000)
      .album('is-this-it', 'Is This It', ['strokes', 'The Strokes'])
      .track('adults', 'The Adults Are Talking', ['strokes', 'The Strokes'], 820_000)
      .done()
    expect(order('the strokes', answer)[0]).toBe('strokes')
    expect(order('strokes', answer)[0]).toBe('strokes')
    expect(top('strokes', answer)).toEqual({ type: 'artist', id: 'strokes', score: 2 })
  })

  it('leads with an album over a better known artist whose name only starts with the query (kid a)', () => {
    const radiohead = ['radiohead', 'Radiohead'] as [string, string]
    const answer = fixture()
      .artist('kid-abelha', 'Kid Abelha', 600_000).artist('kid-a-artist', 'Kid A', 400)
      .album('kid-a', 'Kid A', radiohead).album('kid-a-mnesia', 'KID A MNESIA', radiohead)
      .track('kid-a-song', 'Kid A', radiohead, 450_000, 'kid-a')
      .done()
    const list = order('kid a', answer)
    expect(list.slice(0, 2)).toEqual(['kid-a', 'kid-a-song'])
    expect(list.indexOf('kid-abelha')).toBeLessThan(list.indexOf('kid-a-artist'))
    expect(top('kid a', answer)).toEqual({ type: 'album', id: 'kid-a', score: 3 })
  })

  it('finds an artist by its name alone and with a title (radiohead)', () => {
    const radiohead = ['radiohead', 'Radiohead'] as [string, string]
    const answer = fixture()
      .artist('radiohead', 'Radiohead', 4_000_000).artist('tribute', 'Radiohead Tribute', 300)
      .album('ok-computer', 'OK Computer', radiohead).album('ok-computer-oknotok', 'OK Computer OKNOTOK 1997 2017', radiohead)
      .track('creep', 'Creep', radiohead, 900_000).track('karma', 'Karma Police', radiohead, 850_000, 'ok-computer')
      .done()
    expect(order('radiohead', answer)[0]).toBe('radiohead')
    expect(order('radiohead ok computer', answer)[0]).toBe('ok-computer')
    expect(order('radiohead karma', answer)[0]).toBe('karma')
  })

  it('ignores diacritics, punctuation and spacing (björk, AC/DC)', () => {
    const bjork = fixture().artist('bjork-tribute', 'Bjork Tribute Orchestra', 900).artist('bjork', 'Björk', 900_000).done()
    expect(order('björk', bjork)[0]).toBe('bjork')
    expect(order('bjork', bjork)[0]).toBe('bjork')
    const acdc = fixture().artist('tribute', 'AC/DC Tribute', 2_000).artist('acdc', 'AC/DC', 9_000_000).artist('acid', 'Acid', 30_000).done()
    for (const query of ['AC/DC', 'acdc', 'ac dc']) expect(order(query, acdc)[0]).toBe('acdc')
    expect(top('acdc', acdc)).toEqual({ type: 'artist', id: 'acdc', score: 2 })
  })

  it('reads dollar signs as the letter they stand for ($uicideboy$)', () => {
    const answer = fixture().artist('suicide-silence', 'Suicide Silence', 250_000).artist('boys', '$uicideboy$', 2_500_000)
      .track('paris', 'Paris', ['boys', '$uicideboy$'], 750_000).done()
    for (const query of ['$uicideboy$', 'suicideboys', 'uicideboy']) expect(order(query, answer)[0]).toBe('boys')
  })

  it('puts an album before the title song it shares a name with (thriller)', () => {
    const mj = ['mj', 'Michael Jackson'] as [string, string]
    const answer = fixture()
      .artist('thriller-band', 'Thriller', 500)
      .album('thriller', 'Thriller', mj).album('thriller-25', 'Thriller 25 Super Deluxe Edition', mj)
      .track('thriller-song', 'Thriller', mj, 850_000, 'thriller').track('fob', 'Thriller', ['fob', 'Fall Out Boy'], 300_000)
      .done()
    const list = order('thriller', answer)
    expect(list.slice(0, 2)).toEqual(['thriller', 'thriller-song'])
    expect(list.indexOf('fob')).toBeLessThan(list.indexOf('thriller-band'))
  })

  it('orders two artists of one name by how known they are, whatever the provider listed first (nirvana)', () => {
    const answer = fixture().artist('nirvana-uk', 'Nirvana', 6_000).artist('nirvana', 'Nirvana', 8_000_000).done()
    expect(order('nirvana', answer)).toEqual(['nirvana', 'nirvana-uk'])
  })

  it('raises what is in the library and what the viewer plays', () => {
    const answer = fixture().artist('famous', 'Echo Lake Orchestra', 900_000).artist('owned', 'Echo', 1_000).done()
    // Without the library the better known prefix match leads.
    expect(order('echo', answer)[0]).toBe('famous')
    const owned = { ...answer, signals: { ...answer.signals, owned: new Set(['owned']) } }
    expect(order('echo', owned)[0]).toBe('owned')
    const played = { ...answer, signals: { ...answer.signals, plays: new Map([['owned', 4]]) } }
    expect(order('echo', played)[0]).toBe('owned')
  })

  it('falls back to each list order when nothing measures prominence', () => {
    const built = fixture().album('b', 'Blue', ['x', 'X']).album('a', 'Blue', ['y', 'Y']).track('c', 'Blue', ['z', 'Z'], 0).done()
    const answer = { ...built, signals: { ...built.signals, popularity: new Map() } }
    // Each list keeps its order; the same place in two lists goes to the album.
    expect(order('blue', answer)).toEqual(['b', 'c', 'a'])
  })

  it('never leads with a result found only through its artist or the provider', () => {
    const answer = fixture().album('album', 'Something Else', ['band', 'Band']).artist('other', 'Unrelated', 1_000_000).done()
    expect(rank('band', answer.inputs, answer.signals)[0]!.id).toBe('album')
    expect(top('band', answer)).toBeNull()
  })

  it('leads a song named with its artist with the song, not its single (creep radiohead)', () => {
    const radiohead = ['radiohead', 'Radiohead'] as [string, string]
    const build = fixture().artist('radiohead', 'Radiohead', 4_000_000)
      .album('creep-single', 'Creep', radiohead, 'single').album('pablo-honey', 'Pablo Honey', radiohead)
      .track('creep', 'Creep', radiohead, 900_000, 'creep-single')
    // The library's own Radiohead songs, found because the query names the band.
    for (const title of ['Airbag', 'Lucky', 'Karma Police', 'Kid A']) build.track(`owned-${title}`, title, radiohead, 0)
    const answer = build.done()
    const owned = { ...answer, signals: { ...answer.signals, owned: new Set(answer.inputs.filter((input) => input.id.startsWith('owned-')).map((input) => input.id)) } }
    const list = order('creep radiohead', owned)
    expect(list.slice(0, 2)).toEqual(['creep', 'creep-single'])
    expect(list.indexOf('owned-Airbag')).toBeGreaterThan(list.indexOf('radiohead'))
  })

  it('takes a typo or two swapped letters for the well known name over a song titled with the typo', () => {
    for (const [query, name, fans] of [['kendrik lamar', 'Kendrick Lamar', 9_000_000], ['radiohed', 'Radiohead', 4_000_000], ['taylor swfit', 'Taylor Swift', 20_000_000]] as const) {
      const answer = fixture().artist('real', name, fans).track('literal', query, ['nobody', 'Nobody'], 40_000).done()
      expect(order(query, answer)[0]).toBe('real')
      expect(top(query, answer)).toMatchObject({ type: 'artist', id: 'real' })
    }
  })

  it('reads letters spelled with symbols, and searches a name of symbols alone (P!nk, !!!)', () => {
    const pink = fixture().artist('pink-floyd', 'Pink Floyd', 6_000_000).artist('pink', 'P!nk', 8_000_000).artist('other', 'Pink', 3_000).done()
    expect(order('pink', pink)[0]).toBe('pink')
    const bang = fixture().artist('bang', '!!!', 200_000).artist('ex', 'Exclaim', 50_000).done()
    expect(order('!!!', bang)[0]).toBe('bang')
    expect(top('!!!', bang)).toEqual({ type: 'artist', id: 'bang', score: 3 })
  })
})

describe('isCreditLine', () => {
  it('tells credit lines Deezer lists as artists from artists', () => {
    for (const name of ['Performed by Beyoncé Knowles,', 'Tech N9ne feat. Kendrick Lamar, Kendall Morgan', 'A ft. B', 'Somebody featuring Somebody Else']) expect(isCreditLine(name)).toBe(true)
    for (const name of ['Beyoncé', 'Not Tyler, The Creator', 'Earth, Wind & Fire', 'Featurette']) expect(isCreditLine(name)).toBe(false)
  })
})

