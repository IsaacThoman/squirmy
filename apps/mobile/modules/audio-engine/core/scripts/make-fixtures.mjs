// Writes the Swift core's test fixtures with the server's tone generator: a quiet 3 s sweep
// cut in two at a frame that is no codec's frame size multiple, each half encoded on its own
// in every format the engine decodes. Run from the repository root with ffmpeg on the PATH:
//
//   npx tsx apps/mobile/modules/audio-engine/core/scripts/make-fixtures.mjs
//
// The output is committed, so the Swift tests need no ffmpeg; run this again only to change it.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { profiles } from '../../../../../server/src/modules/streaming/profiles.ts'
import { makeSplitTonePairs } from '../../../../../server/src/test/audio.ts'

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../Tests/SquirmyAudioCoreTests/Fixtures')

const { reference, pairs } = await makeSplitTonePairs(directory, {
  durationSec: 3,
  splitFrame: 58_211,
  levelDb: -40,
  encodings: {
    // Originals, as a library holds them. ffmpeg writes each file's own gapless information:
    // FLAC's exact length, the MP4 edit list, the LAME tag and Ogg Opus's pre-skip and end trim.
    flac: { extension: 'flac', args: ['-c:a', 'flac', '-frame_size', '4096'] },
    alac: { extension: 'm4a', args: ['-c:a', 'alac'] },
    aac: { extension: 'm4a', args: ['-c:a', 'aac', '-b:a', '160k'] },
    mp3: { extension: 'mp3', args: ['-c:a', 'libmp3lame', '-b:a', '160k'] },
    opus: { extension: 'opus', args: ['-ar', '48000', '-c:a', 'libopus', '-b:a', '96k'] },
    // Today's transcodes, with the server's own arguments: no gapless information at all.
    aac_256: { extension: profiles.aac_256.extension, args: profiles.aac_256.args },
    mp3_320: { extension: profiles.mp3_320.extension, args: profiles.mp3_320.args },
  },
})

console.log([reference, ...Object.values(pairs).flatMap(pair => [pair.a, pair.b])].map(file => path.relative(process.cwd(), file)).join('\n'))
