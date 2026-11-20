// Generates the test tones the /dev/engine page plays: short, very quiet sines with no
// encoder padding (FLAC), plus a file that is not audio. They are served by the dev server
// from the git-ignored .dev-audio/ folder. Usage: node scripts/dev-audio.mjs
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
}
writeFileSync(new URL('broken.flac', out), randomBytes(8192))
console.log(`Wrote ${tones.map(tone => `${tone.name}.flac`).join(', ')} and broken.flac to ${out.pathname}`)
