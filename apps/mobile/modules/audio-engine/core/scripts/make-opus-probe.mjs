// Writes the samples the engine's Opus probe decodes (`Sources/SquirmyAudioCore/OpusProbeSamples.swift`):
// a tenth of a second of a very quiet tone as Opus in fragmented MP4, with the server's
// `opus_mp4_96` arguments and last-packet rewriter, and as Ogg Opus, as an original file is.
// Run from the repository root with ffmpeg on the PATH:
//
//   npx tsx apps/mobile/modules/audio-engine/core/scripts/make-opus-probe.mjs
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { rewritePacketDurations } from '../../../../../server/src/modules/streaming/mp4.ts'
import { fragmentedEncoder, profiles } from '../../../../../server/src/modules/streaming/profiles.ts'

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), '../Sources/SquirmyAudioCore/OpusProbeSamples.swift')
const frames = 4800
const tone = ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${frames / 48000}`, '-af', 'volume=-40dB', '-ac', '2']
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', ...args], { maxBuffer: 1 << 20 })

const piped = ffmpeg(...tone, '-ar', '48000', ...profiles.opus_mp4_96.args, 'pipe:1')
const chunks = []
for await (const chunk of rewritePacketDurations(Readable.from([piped]), fragmentedEncoder('opus_mp4_96').packetFrames)) chunks.push(chunk)
const mp4 = Buffer.concat(chunks)
const ogg = ffmpeg(...tone, '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1')

const literal = (bytes) => bytes.toString('base64').match(/.{1,100}/g).map(line => `    "${line}"`).join(',\n')
writeFileSync(output, `// Written by scripts/make-opus-probe.mjs; run it again to change these.

extension OpusProbe {
  /// Real frames in each sample: a tenth of a second at 48 kHz.
  static let sampleFrames: Int64 = ${frames}

  /// The tone as the server's \`opus_mp4_96\` sends it.
  static let fragmentedSample = [
${literal(mp4)},
  ].joined()

  /// The tone as an Ogg Opus file.
  static let oggSample = [
${literal(ogg)},
  ].joined()
}
`)
console.log(`${mp4.length} bytes of fragmented MP4, ${ogg.length} of Ogg`)
