// Generates the test tones the /dev/engine page plays: short, very quiet sines with no
// encoder padding (FLAC, and the same in fragmented MP4 as the server writes it for Media
// Source Extensions), plus files that are not audio. They are served by the dev server from
// the git-ignored .dev-audio/ folder. Usage: node scripts/dev-audio.mjs
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const out = new URL('../.dev-audio/', import.meta.url)
mkdirSync(out, { recursive: true })

// Amplitude 0.02 is about -34 dBFS: audible on headphones, never loud even at 2x gain.
const tones = [
  { name: 'a', frequency: 440, seconds: 4 },
  { name: 'b', frequency: 660, seconds: 3 },
  { name: 'c', frequency: 550, seconds: 1.5 },
]
for (const tone of tones) {
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y', '-f', 'lavfi',
    // Both channels spelled out: upmixing mono would lower the level by 3 dB.
    '-i', `aevalsrc=0.02*sin(2*PI*${tone.frequency}*t)|0.02*sin(2*PI*${tone.frequency}*t):s=44100:d=${tone.seconds}`,
    '-c:a', 'flac', new URL(`${tone.name}.flac`, out).pathname,
  ])
  // The server's fragmented MP4 options (apps/server/src/modules/streaming/profiles.ts): no edit list.
  execFileSync('ffmpeg', [
    '-loglevel', 'error', '-y', '-i', new URL(`${tone.name}.flac`, out).pathname, '-c:a', 'copy',
    '-f', 'mp4', '-movflags', '+delay_moov+default_base_moof', '-use_editlist', '0', '-frag_duration', '500000', '-strict', 'experimental',
    new URL(`${tone.name}.mp4`, out).pathname,
  ])
}
writeFileSync(new URL('broken.flac', out), randomBytes(8192))
writeFileSync(new URL('broken.mp4', out), randomBytes(8192))
console.log(`Wrote ${tones.map(tone => `${tone.name}.flac and .mp4`).join(', ')}, broken.flac and broken.mp4 to ${out.pathname}`)
