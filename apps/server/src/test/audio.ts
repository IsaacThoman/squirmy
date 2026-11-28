import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type ToneFormat = 'flac' | 'mp3' | 'm4a' | 'ogg' | 'opus' | 'wav'

export type ToneSpec = {
  /** Output path relative to the directory passed to makeTone; the extension picks the format. */
  path: string
  durationSec?: number
  frequency?: number
  /**
   * Gain applied to the tone, which starts at -18 dBFS. Keep it very quiet: tests play
   * these out loud. The default of -50 dB is below the loudness meter's -70 LUFS gate, so
   * such a file measures as silence; use about -30 dB when a test needs a real reading.
   */
  volumeDb?: number
  /** Written as-is with `-metadata`. Use the container's own tag names (e.g. MUSICBRAINZ_ALBUMID). */
  tags?: Record<string, string | number>
  /** Embed a small solid-color cover. */
  cover?: boolean | string
  /** MP3 only: omit the Xing/Info header and its LAME-compatible gapless data. */
  withoutXingHeader?: boolean
  /** M4A only: encode lossless ALAC here instead of AAC. */
  alac?: boolean
  /** Sample rate in Hz. Defaults to 44100. */
  sampleRate?: number
  /**
   * FLAC and WAV only: the bits per sample. Unset, WAV is 16-bit and FLAC takes the 24 bits the
   * volume filter's samples carry; set 16 for a CD-quality FLAC.
   */
  bitDepth?: 16 | 24
}

const codecs: Record<ToneFormat, string[]> = {
  flac: ['-c:a', 'flac'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3'],
  m4a: ['-c:a', 'aac', '-b:a', '128k'],
  // ffmpeg's built-in encoder, so fixtures do not depend on a libvorbis build.
  ogg: ['-c:a', 'vorbis', '-strict', 'experimental'],
  opus: ['-c:a', 'libopus', '-b:a', '64k'],
  wav: ['-c:a', 'pcm_s16le'],
}

const ffmpeg = () => process.env.FFMPEG_PATH ?? 'ffmpeg'

/** Encoder arguments for a bit depth, which only the lossless formats here keep. */
function deeper(format: ToneFormat, bitDepth: 16 | 24 | undefined): string[] {
  if (bitDepth === undefined) return []
  if (format === 'flac') return bitDepth === 24 ? ['-sample_fmt', 's32', '-bits_per_raw_sample', '24'] : ['-sample_fmt', 's16']
  if (format === 'wav') return bitDepth === 24 ? ['-c:a', 'pcm_s24le'] : []
  throw new Error(`A ${format} fixture has no bit depth`)
}

/**
 * A small solid-color JPEG, made once per color and reused. Test files run in parallel
 * processes that share the temp folder, so the image is written under a name of its own
 * and renamed into place: another process never reads one that is half written.
 */
async function coverImage(color: string): Promise<string> {
  const file = path.join(tmpdir(), `squirmy-cover-${color.replace(/[^a-z0-9]/gi, '')}.jpg`)
  try {
    await access(file)
  } catch {
    const partial = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.jpg`
    await run(ffmpeg(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=96x96`, '-frames:v', '1', partial])
    await rename(partial, file)
  }
  return file
}

/** Writes one sine tone with the given tags and returns its absolute path. */
export async function makeTone(directory: string, spec: ToneSpec): Promise<string> {
  const output = path.join(directory, spec.path)
  const format = path.extname(output).slice(1) as ToneFormat
  if (!codecs[format]) throw new Error(`Unsupported fixture format: ${format}`)
  await mkdir(path.dirname(output), { recursive: true })

  const duration = spec.durationSec ?? 2
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${spec.frequency ?? 440}:duration=${duration}:sample_rate=${spec.sampleRate ?? 44100}`]
  const withCover = spec.cover && (format === 'flac' || format === 'mp3' || format === 'm4a')
  if (withCover) {
    const image = await coverImage(typeof spec.cover === 'string' ? spec.cover : 'purple')
    args.push('-i', image, '-map', '0:a', '-map', '1:v', '-c:v', 'copy', '-disposition:v', 'attached_pic')
  }
  const encoder = format === 'm4a' && spec.alac ? ['-c:a', 'alac'] : codecs[format]
  args.push('-af', `volume=${spec.volumeDb ?? -50}dB`, '-ac', '2', ...encoder, ...deeper(format, spec.bitDepth))
  if (format === 'mp3' && spec.withoutXingHeader) args.push('-write_xing', '0')
  for (const [key, value] of Object.entries(spec.tags ?? {})) args.push('-metadata', `${key}=${value}`)
  args.push(output)
  await run(ffmpeg(), args)
  return output
}

/** A quiet stereo chirp split between codec packet boundaries, with an uncut FLAC reference. */
export async function makeSplitTone(directory: string, {
  rate = 44_100, format = 'flac',
}: { rate?: number; format?: 'flac' | 'm4a' | 'mp3' | 'alac' } = {}) {
  const frames = [133_077, 88_533] as const
  const total = frames[0] + frames[1]
  const pcm = new Float32Array(total * 2)
  for (let index = 0; index < total; index++) {
    const t = index / rate
    pcm[2 * index] = 0.023 * Math.sin(2 * Math.PI * (251 * t + 159 * t * t))
    pcm[2 * index + 1] = 0.019 * Math.sin(2 * Math.PI * (113 * t + 221 * t * t))
  }
  await mkdir(directory, { recursive: true })
  const raw = path.join(directory, '.chirp.f32')
  const write = async (name: string, from: number, to: number, codec: typeof format) => {
    const output = path.join(directory, `${name}.${codec === 'alac' ? 'm4a' : codec}`)
    await run(ffmpeg(), [
      '-v', 'error', '-f', 'f32le', '-ar', String(rate), '-ac', '2', '-i', raw,
      '-af', `atrim=start_sample=${from}:end_sample=${to},asetpts=PTS-STARTPTS`,
      ...(codec === 'alac' ? ['-c:a', 'alac'] : codecs[codec]), '-metadata', `title=${name}`, '-metadata', 'artist=Fixture', output,
    ])
    return output
  }
  await writeFile(raw, new Uint8Array(pcm.buffer))
  try {
    const whole = await write('Whole', 0, total, 'flac')
    const first = await write('First', 0, frames[0], format)
    const second = await write('Second', frames[0], total, format)
    return { whole, halves: [first, second] as const, frames, rate }
  } finally {
    await rm(raw, { force: true })
  }
}

export type AlbumSpec = {
  artist: string
  album: string
  year?: number
  genre?: string
  format?: ToneFormat
  /** Level for every track of the album; see ToneSpec.volumeDb. */
  volumeDb?: number
  /** Folder under the library root. Defaults to "Artist/Album". */
  folder?: string
  tracks: { title: string; durationSec?: number; artist?: string; disc?: number; tags?: Record<string, string | number> }[]
  /** Tags written to every track, e.g. MUSICBRAINZ_ALBUMID. */
  tags?: Record<string, string | number>
  cover?: boolean | string
}

/** Writes a tagged album of tones under `root` and returns the file paths in track order. */
export async function makeAlbum(root: string, spec: AlbumSpec): Promise<string[]> {
  const format = spec.format ?? 'flac'
  const folder = spec.folder ?? path.join(spec.artist, spec.album)
  const paths: string[] = []
  const positions = new Map<number, number>()
  for (const track of spec.tracks) {
    const disc = track.disc ?? 1
    const position = (positions.get(disc) ?? 0) + 1
    positions.set(disc, position)
    const number = String(position).padStart(2, '0')
    paths.push(await makeTone(root, {
      path: path.join(folder, `${disc > 1 ? `${disc}-` : ''}${number} ${track.title.replace(/[/\\:]/g, '_')}.${format}`),
      durationSec: track.durationSec,
      volumeDb: spec.volumeDb,
      frequency: 220 + position * 40,
      cover: spec.cover,
      tags: {
        title: track.title,
        artist: track.artist ?? spec.artist,
        album_artist: spec.artist,
        album: spec.album,
        track: `${position}/${spec.tracks.filter((other) => (other.disc ?? 1) === disc).length}`,
        ...(disc > 1 || spec.tracks.some((other) => (other.disc ?? 1) > 1) ? { disc } : {}),
        ...(spec.year ? { date: spec.year } : {}),
        ...(spec.genre ? { genre: spec.genre } : {}),
        ...spec.tags,
        ...track.tags,
      },
    }))
  }
  return paths
}

/**
 * Files with an audio name whose content makes ffmpeg reach past them: a concat script
 * that plays `target` (a plain file name in the same folder: letters, digits, `.`, `-`, `_`), an HLS playlist and a DASH manifest
 * with segments at `url`, and an SDP description that opens RTP sockets. Returns their paths.
 */
export async function writeHostileInputs(directory: string, options: { target: string; url: string }) {
  const files = {
    concat: path.join(directory, 'concat.flac'),
    hls: path.join(directory, 'hls.flac'),
    dash: path.join(directory, 'dash.flac'),
    sdp: path.join(directory, 'sdp.flac'),
  }
  await mkdir(directory, { recursive: true })
  await writeFile(files.concat, `ffconcat version 1.0\nfile ${options.target}\n`)
  await writeFile(files.hls, `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\n${options.url}/segment.ts\n#EXT-X-ENDLIST\n`)
  await writeFile(files.dash, [
    '<?xml version="1.0"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="PT10S">',
    `<BaseURL>${options.url}/</BaseURL><Period><AdaptationSet mimeType="audio/mp4"><Representation id="a" bandwidth="1000"><BaseURL>a.m4a</BaseURL></Representation></AdaptationSet></Period></MPD>`,
  ].join('\n'))
  const host = new URL(options.url).hostname
  await writeFile(files.sdp, `v=0\no=- 0 0 IN IP4 ${host}\ns=x\nc=IN IP4 ${host}\nt=0 0\nm=audio 9 RTP/AVP 0\n`)
  return files
}

export type BeatSpec = {
  durationSec: number
  /** Clicks on every beat at this tempo; none without it. */
  bpm?: number
  /** When the first click falls. */
  firstBeatSec?: number
  /** Chords (frequencies in Hz) played in turn for `chordSec` each, as sine tones. */
  chords?: number[][]
  chordSec?: number
  /** Click pitch: higher sounds brighter. */
  clickHz?: number
  /** Amplitude of white noise mixed in, before `volumeDb`. */
  noise?: number
  fadeInSec?: number
  fadeOutSec?: number
  /** Leading and trailing digital silence. */
  silenceSec?: number
  /** Gain on the whole mix. Keep it quiet: tests play fixtures out loud. */
  volumeDb?: number
  sampleRate?: number
}

/** Pitches of chords for key tests, in Hz: I–IV–V–I in C major and i–iv–V–i in A minor. */
export const chords = {
  cMajor: [[261.63, 329.63, 392], [349.23, 440, 523.25], [392, 493.88, 587.33], [261.63, 329.63, 392]],
  aMinor: [[220, 261.63, 329.63], [293.66, 349.23, 440], [329.63, 415.3, 493.88], [220, 261.63, 329.63]],
}

/**
 * Mono samples of a click track: a short decaying click on every beat, chords underneath
 * and optional noise, with fades and silence at the ends. Deterministic (the noise is
 * seeded), so analysis tests repeat exactly.
 */
export function beatSamples(spec: BeatSpec): Float32Array {
  const rate = spec.sampleRate ?? 22050
  const silence = spec.silenceSec ?? 0
  const body = Math.round(spec.durationSec * rate)
  const lead = Math.round(silence * rate)
  const out = new Float32Array(body + 2 * lead)
  const gain = 10 ** ((spec.volumeDb ?? -24) / 20)
  const first = spec.firstBeatSec ?? 0.25
  const period = spec.bpm ? 60 / spec.bpm : 0
  const chordSec = spec.chordSec ?? 2
  const clickHz = spec.clickHz ?? 1500
  let state = 0x9e3779b9
  const noise = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 31 - 1
  }
  for (let i = 0; i < body; i++) {
    const t = i / rate
    let sample = 0
    if (period && t >= first) {
      const since = (t - first) % period
      sample += 0.5 * Math.sin(2 * Math.PI * clickHz * since) * Math.exp(-40 * since)
    }
    if (spec.chords?.length) {
      const chord = spec.chords[Math.floor(t / chordSec) % spec.chords.length]!
      for (const hz of chord) sample += (0.24 / chord.length) * Math.sin(2 * Math.PI * hz * t)
    }
    if (spec.noise) sample += spec.noise * noise()
    let envelope = 1
    if (spec.fadeInSec && t < spec.fadeInSec) envelope = t / spec.fadeInSec
    if (spec.fadeOutSec && t > spec.durationSec - spec.fadeOutSec) envelope = Math.min(envelope, (spec.durationSec - t) / spec.fadeOutSec)
    out[lead + i] = sample * envelope * gain
  }
  return out
}

/** Writes `beatSamples` to an audio file with tags, like `makeTone`, and returns its path. */
export async function makeBeatTrack(directory: string, spec: BeatSpec & { path: string; tags?: Record<string, string | number> }): Promise<string> {
  const output = path.join(directory, spec.path)
  const format = path.extname(output).slice(1) as ToneFormat
  if (!codecs[format]) throw new Error(`Unsupported fixture format: ${format}`)
  await mkdir(path.dirname(output), { recursive: true })
  const rate = spec.sampleRate ?? 22050
  const raw = path.join(directory, `.${path.basename(output)}.${randomBytes(4).toString('hex')}.f32`)
  const samples = beatSamples({ ...spec, sampleRate: rate })
  await writeFile(raw, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
  const args = ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(rate), '-ac', '1', '-i', raw, '-ac', '2', '-ar', '44100', ...codecs[format]]
  for (const [key, value] of Object.entries(spec.tags ?? {})) args.push('-metadata', `${key}=${value}`)
  args.push(output)
  try {
    await run(ffmpeg(), args)
  } finally {
    await rm(raw, { force: true })
  }
  return output
}
