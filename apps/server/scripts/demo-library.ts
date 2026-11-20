/**
 * Generates a demo music library: real album and track names with real running times,
 * but every file is a very quiet sine tone. Use it to try the server without pointing
 * it at your own collection.
 *
 *   npm run demo:library -w @squirmy/server -- <output directory> [--short]
 *
 * `--short` makes every track three seconds long, which is fast but defeats
 * duration-based album matching.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { makeAlbum, makeTone, type AlbumSpec } from '../src/test/audio.js'

const t = (title: string, time: string, extra: Partial<AlbumSpec['tracks'][number]> = {}) => {
  const [minutes, seconds] = time.split(':').map(Number)
  return { title, durationSec: (minutes ?? 0) * 60 + (seconds ?? 0), ...extra }
}

const albums: AlbumSpec[] = [
  {
    artist: 'Radiohead', album: 'OK Computer', year: 1997, genre: 'Alternative Rock', format: 'flac', cover: '0x4a6fa5',
    tracks: [
      t('Airbag', '4:44'), t('Paranoid Android', '6:23'), t('Subterranean Homesick Alien', '4:27'),
      t('Exit Music (For a Film)', '4:24'), t('Let Down', '4:59'), t('Karma Police', '4:21'),
      t('Fitter Happier', '1:57'), t('Electioneering', '3:50'), t('Climbing Up the Walls', '4:45'),
      t('No Surprises', '3:48'), t('Lucky', '4:19'), t('The Tourist', '5:24'),
    ],
  },
  {
    artist: 'Daft Punk', album: 'Discovery', year: 2001, genre: 'Electronic', format: 'mp3', cover: '0x1b1b3a',
    tracks: [
      t('One More Time', '5:20'), t('Aerodynamic', '3:27'), t('Digital Love', '4:58'),
      t('Harder, Better, Faster, Stronger', '3:45'), t('Crescendolls', '3:31'), t('Nightvision', '1:44'),
      t('Superheroes', '3:57'), t('High Life', '3:22'), t('Something About Us', '3:51'), t('Voyager', '3:47'),
      t('Veridis Quo', '5:44'), t('Short Circuit', '3:26'), t('Face to Face', '3:58'), t('Too Long', '10:00'),
    ],
  },
  {
    artist: 'Daft Punk', album: 'Random Access Memories', year: 2013, genre: 'Electronic', format: 'flac', cover: '0x111111',
    tracks: [
      t('Give Life Back to Music', '4:35'), t('The Game of Love', '5:22'), t('Giorgio by Moroder', '9:04'), t('Within', '3:48'),
      t('Instant Crush', '5:37', { artist: 'Daft Punk feat. Julian Casablancas' }),
      t('Lose Yourself to Dance', '5:53', { artist: 'Daft Punk feat. Pharrell Williams' }),
      t('Touch', '8:18', { artist: 'Daft Punk feat. Paul Williams' }),
      t('Get Lucky', '6:09', { artist: 'Daft Punk feat. Pharrell Williams & Nile Rodgers' }),
      t('Beyond', '4:50'), t('Motherboard', '5:41'),
      t('Fragments of Time', '4:39', { artist: 'Daft Punk feat. Todd Edwards' }),
      t("Doin' It Right", '4:11', { artist: 'Daft Punk feat. Panda Bear' }), t('Contact', '6:21'),
    ],
  },
  {
    artist: 'The Beatles', album: 'Abbey Road', year: 1969, genre: 'Rock', format: 'm4a', cover: '0x6b8e6b',
    tracks: [
      t('Come Together', '4:19'), t('Something', '3:02'), t("Maxwell's Silver Hammer", '3:27'), t('Oh! Darling', '3:27'),
      t("Octopus's Garden", '2:51'), t("I Want You (She's So Heavy)", '7:47'), t('Here Comes the Sun', '3:05'),
      t('Because', '2:45'), t('You Never Give Me Your Money', '4:03'), t('Sun King', '2:26'), t('Mean Mr. Mustard', '1:06'),
      t('Polythene Pam', '1:13'), t('She Came In Through the Bathroom Window', '1:58'), t('Golden Slumbers', '1:31'),
      t('Carry That Weight', '1:36'), t('The End', '2:05'), t('Her Majesty', '0:23'),
    ],
  },
  {
    // Two discs in CD1 / CD2 subfolders, the way ripped box sets usually arrive.
    artist: 'Pink Floyd', album: 'The Wall', year: 1979, genre: 'Progressive Rock', format: 'flac', cover: '0xf5f5f0',
    tracks: [
      t('In the Flesh?', '3:19'), t('The Thin Ice', '2:27'), t('Another Brick in the Wall, Part 1', '3:11'),
      t('The Happiest Days of Our Lives', '1:46'), t('Another Brick in the Wall, Part 2', '3:59'), t('Mother', '5:32'),
      t('Goodbye Blue Sky', '2:45'), t('Empty Spaces', '2:10'), t('Young Lust', '3:25'), t('One of My Turns', '3:41'),
      t("Don't Leave Me Now", '4:08'), t('Another Brick in the Wall, Part 3', '1:48'), t('Goodbye Cruel World', '0:48'),
      ...[
        t('Hey You', '4:40'), t('Is There Anybody Out There?', '2:44'), t('Nobody Home', '3:26'), t('Vera', '1:35'),
        t('Bring the Boys Back Home', '1:21'), t('Comfortably Numb', '6:23'), t('The Show Must Go On', '1:36'),
        t('In the Flesh', '4:15'), t('Run Like Hell', '4:20'), t('Waiting for the Worms', '4:04'), t('Stop', '0:30'),
        t('The Trial', '5:13'), t('Outside the Wall', '1:41'),
      ].map((track) => ({ ...track, disc: 2 })),
    ],
  },
  {
    artist: 'Various Artists', album: 'Guardians of the Galaxy: Awesome Mix Vol. 1', year: 2014, genre: 'Soundtrack', format: 'mp3',
    cover: '0xc46a2b', tags: { compilation: 1 },
    tracks: [
      t('Hooked on a Feeling', '2:52', { artist: 'Blue Swede' }), t('Go All the Way', '3:21', { artist: 'Raspberries' }),
      t('Spirit in the Sky', '4:02', { artist: 'Norman Greenbaum' }), t('Moonage Daydream', '4:41', { artist: 'David Bowie' }),
      t('Fooled Around and Fell in Love', '4:35', { artist: 'Elvin Bishop' }), t("I'm Not in Love", '6:03', { artist: '10cc' }),
      t('I Want You Back', '2:58', { artist: 'The Jackson 5' }), t('Come and Get Your Love', '3:25', { artist: 'Redbone' }),
      t('Cherry Bomb', '2:17', { artist: 'The Runaways' }), t('Escape (The Piña Colada Song)', '4:36', { artist: 'Rupert Holmes' }),
      t('O-o-h Child', '3:13', { artist: 'The Five Stairsteps' }),
      t("Ain't No Mountain High Enough", '2:29', { artist: 'Marvin Gaye & Tammi Terrell' }),
    ],
  },
  {
    artist: '椎名林檎', album: '無罪モラトリアム', year: 1999, genre: 'J-Pop', format: 'flac', cover: '0xb03a48',
    tracks: [
      t('正しい街', '3:53'), t('歌舞伎町の女王', '2:53'), t('丸の内サディスティック', '3:56'), t('幸福論(悦楽編)', '3:16'),
      t('茜さす 帰路照らされど…', '4:07'), t('シドと白昼夢', '4:00'), t('積木遊び', '3:25'), t('ここでキスして。', '4:20'),
      t('同じ夜', '3:38'), t('警告', '4:02'), t('モルヒネ', '3:57'),
    ],
  },
  // Fictional albums from the app's prototype. They match nothing, so they stay local-only.
  {
    artist: 'Mira Vale', album: 'Blue Hour', year: 2025, genre: 'Dream Pop', format: 'flac', cover: '0x344763',
    tracks: [t('Night Swimming', '3:44'), t('Soft Signal', '3:18'), t('Blue in the Dark', '3:57'), t('Underwater Light', '3:33'), t('Stay Until Morning', '4:29')],
  },
  {
    artist: 'Lune Park', album: 'Slow Motion', year: 2024, genre: 'Alternative', format: 'ogg',
    tracks: [t('Amber', '3:26'), t('After the Rain', '3:38'), t('Riverside', '4:01'), t('Open Window', '3:18')],
  },
]

async function main() {
  const args = process.argv.slice(2)
  const short = args.includes('--short')
  const output = args.find((arg) => !arg.startsWith('--'))
  if (!output) {
    console.error('Usage: demo-library <output directory> [--short]')
    process.exit(1)
  }
  const root = path.resolve(output)
  await mkdir(root, { recursive: true })

  let count = 0
  for (const album of albums) {
    const multiDisc = album.tracks.some((track) => (track.disc ?? 1) > 1)
    if (!multiDisc) {
      const spec = short ? { ...album, tracks: album.tracks.map((track) => ({ ...track, durationSec: 3 })) } : album
      count += (await makeAlbum(root, spec)).length
    } else {
      for (const disc of new Set(album.tracks.map((track) => track.disc ?? 1))) {
        const tracks = album.tracks.filter((track) => (track.disc ?? 1) === disc).map((track) => ({ ...track, disc: undefined, ...(short ? { durationSec: 3 } : {}) }))
        count += (await makeAlbum(root, {
          ...album,
          tracks,
          folder: path.join(album.artist, album.album, `CD${disc}`),
          tags: { ...album.tags, disc: `${disc}/2` },
        })).length
      }
    }
    console.info(`✓ ${album.artist} — ${album.album}`)
  }

  // The kind of mess every real library has: loose files with partial or no tags.
  const loose = (seconds: number) => (short ? 3 : seconds)
  await makeTone(root, { path: 'misc rips/track01.mp3', durationSec: loose(201) })
  await makeTone(root, { path: 'misc rips/02 - Karma Police.mp3', durationSec: loose(261), tags: { title: 'Karma Police', artist: 'Radiohead' } })
  await makeTone(root, { path: 'Singles/bad guy.m4a', durationSec: loose(194), tags: { title: 'bad guy', artist: 'Billie Eilish' } })
  count += 3

  console.info(`\n${count} files written to ${root}`)
}

await main()
