// Writes the Swift core's fragmented MP4 fixtures as the server streams them, from the M1
// reference (`Fixtures/ref.flac`, which stays as it is): each half of the split, and the whole,
// as a library file, then encoded with each fragmented profile's own arguments to a pipe and
// through the server's last-packet rewriter, as `transcode.ts` does; and live seeks, encoded
// from `start` the way `planSeek` plans them. The descriptor's gapless numbers for each go in
// `fragmented.json`. Run from the repository root with ffmpeg on the PATH:
//
//   npx tsx apps/mobile/modules/audio-engine/core/scripts/make-fragmented-fixtures.mjs
//
// The output is committed, so the Swift tests need no ffmpeg; run this again only to change it.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { audioInput } from '../../../../../server/src/lib/ffmpeg.ts'
import { rewritePacketDurations } from '../../../../../server/src/modules/streaming/mp4.ts'
import { fragmentedEncoder, outputBitDepth, outputSampleRate, profiles } from '../../../../../server/src/modules/streaming/profiles.ts'

const directory = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../Tests/SquirmyAudioCoreTests/Fixtures')
const reference = path.join(directory, 'ref.flac')
const rate = 44_100
const total = 132_300
const split = 58_211
// The native engine's profiles; `copy_mp4` is for the web's Media Source Extensions only.
const encoded = ['flac_mp4', 'opus_mp4_192', 'opus_mp4_96', 'aac_mp4_256', 'aac_mp4_128']
// Live seeks: one resampled (44.1 kHz into Opus's 48 kHz), one at the source's rate.
const seeks = [{ profile: 'opus_mp4_96', startMs: 2000 }, { profile: 'aac_mp4_256', startMs: 1500 }]

// The reference as the server would see it: 24-bit FLAC, so `flac_mp4` stays 24-bit.
const source = { sampleRate: rate, decodedRate: rate, container: 'flac', bitDepth: 24 }
const sources = mkdtempSync(path.join(tmpdir(), 'squirmy-fragmented-'))
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args])
const halves = {
  a: { file: path.join(sources, 'a.flac'), frames: split },
  b: { file: path.join(sources, 'b.flac'), frames: total - split },
  whole: { file: reference, frames: total },
}
ffmpeg('-i', reference, '-af', `atrim=end_sample=${split}`, '-c:a', 'flac', halves.a.file)
ffmpeg('-i', reference, '-af', `atrim=start_sample=${split},asetpts=PTS-STARTPTS`, '-c:a', 'flac', halves.b.file)

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))

/** `planSeek` in transcode.ts, for a source of `rate`. */
function planSeek(outputRate, startMs) {
  const frame = Math.round(startMs * outputRate / 1000)
  if (rate === outputRate) return { seconds: frame / rate, frame }
  const phase = outputRate / gcd(rate, outputRate)
  const preroll = Math.ceil(64 * outputRate / rate)
  const start = Math.max(0, Math.floor((frame - preroll) / phase) * phase)
  return { seconds: start / outputRate, frame, trimFrames: frame - start }
}

/** `ffmpegArgs` in transcode.ts for this source, without the tags. */
function encode(profile, input, output, seek) {
  const sampleRate = outputSampleRate(source, profile)
  const filters = seek?.trimFrames ? [`aresample=${sampleRate}`, `atrim=start_sample=${seek.trimFrames}`, 'asetpts=PTS-STARTPTS'] : []
  const args = [
    '-v', 'error', '-nostdin', ...(seek ? ['-ss', seek.seconds.toFixed(6)] : []), ...audioInput(input),
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-ar', String(sampleRate),
    ...(filters.length ? ['-af', filters.join(',')] : []),
    ...(profile === 'flac_mp4' ? ['-sample_fmt', outputBitDepth(source, profile) === 16 ? 's16' : 's32'] : []),
    ...profiles[profile].args, 'pipe:1',
  ]
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] })
    const chunks = []
    const packetFrames = fragmentedEncoder(profile)?.packetFrames
    const output = packetFrames ? rewritePacketDurations(child.stdout, packetFrames) : child.stdout
    ;(async () => {
      for await (const chunk of output) chunks.push(chunk)
    })().then(() => child.once('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited with ${code}`))), reject)
  }).then(bytes => writeFileSync(path.join(directory, output), bytes))
}

/** The descriptor's numbers (`playback.ts`): the track's frames at the delivered rate, rounded up. */
function gapless(profile, frames) {
  const sampleRate = outputSampleRate(source, profile)
  return { sampleRate, primingFrames: fragmentedEncoder(profile).primingFrames, frames: Math.ceil(frames * sampleRate / rate) }
}

const numbers = {}
try {
  for (const profile of encoded) {
    for (const half of ['a', 'b']) {
      const name = `${profile}.${half}.mp4`
      await encode(profile, halves[half].file, name)
      numbers[name] = { gapless: gapless(profile, halves[half].frames) }
    }
  }
  for (const { profile, startMs } of seeks) {
    const whole = `${profile}.whole.mp4`
    await encode(profile, reference, whole)
    numbers[whole] = { gapless: gapless(profile, total) }
    const seek = planSeek(outputSampleRate(source, profile), startMs)
    const from = `${profile}.from-${startMs}.mp4`
    await encode(profile, reference, from, seek)
    // `X-Squirmy-Start-Frame`: where the stream's first real sample sits in the track.
    numbers[from] = { gapless: gapless(profile, total), startMs, startFrame: seek.frame }
  }
} finally {
  rmSync(sources, { recursive: true, force: true })
}
writeFileSync(path.join(directory, 'fragmented.json'), `${JSON.stringify(numbers, null, 2)}\n`)
console.log(Object.keys(numbers).join('\n'))
