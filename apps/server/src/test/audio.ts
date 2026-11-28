import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, mkdir, rename, writeFile } from 'node:fs/promises'
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
  args.push('-af', `volume=${spec.volumeDb ?? -50}dB`, '-ac', '2', ...codecs[format], ...deeper(format, spec.bitDepth))
  for (const [key, value] of Object.entries(spec.tags ?? {})) args.push('-metadata', `${key}=${value}`)
  args.push(output)
  await run(ffmpeg(), args)
  return output
}

export type SplitToneSpec = {
  durationSec?: number
  sampleRate?: number
  /** Where the halves meet, in frames. Pick one that is no codec's frame size multiple. */
  splitFrame: number
  /** Peak level in dBFS. Keep it very quiet: these may be played out loud. */
  levelDb?: number
  /** Each encoding of the halves: the output's extension and ffmpeg's codec and muxer arguments. */
  encodings: Record<string, { extension: string; args: string[] }>
}

/**
 * A quiet stereo sweep, a different one per channel so that a cross-correlation has one
 * peak, written whole as `ref.flac`, then cut at `splitFrame` into two halves that are
 * encoded separately in each encoding as `<name>.a.<ext>` and `<name>.b.<ext>`: two
 * consecutive tracks, played without a gap exactly when the halves back to back are the
 * whole. Returns the reference's path and each encoding's pair.
 */
export async function makeSplitTone(directory: string, spec: SplitToneSpec) {
  await mkdir(directory, { recursive: true })
  const rate = spec.sampleRate ?? 44100
  const duration = spec.durationSec ?? 4
  const amplitude = 10 ** ((spec.levelDb ?? -40) / 20)
  const sweep = (from: number, to: number) => `${amplitude}*sin(2*PI*(${from}*t+${(to - from) / (2 * duration)}*t*t))`
  const source = ['-f', 'lavfi', '-i', `aevalsrc=${sweep(220, 1760)}|${sweep(1320, 330)}:s=${rate}:d=${duration}`]
  const reference = path.join(directory, 'ref.flac')
  await run(ffmpeg(), ['-v', 'error', '-y', ...source, '-c:a', 'flac', reference])
  const halves = {
    a: ['-af', `atrim=end_sample=${spec.splitFrame}`],
    b: ['-af', `atrim=start_sample=${spec.splitFrame},asetpts=PTS-STARTPTS`],
  }
  const pairs: Record<string, { a: string; b: string }> = {}
  for (const [name, encoding] of Object.entries(spec.encodings)) {
    const pair = { a: path.join(directory, `${name}.a.${encoding.extension}`), b: path.join(directory, `${name}.b.${encoding.extension}`) }
    for (const half of ['a', 'b'] as const) {
      await run(ffmpeg(), ['-v', 'error', '-y', '-i', reference, ...halves[half], ...encoding.args, pair[half]])
    }
    pairs[name] = pair
  }
  return { reference, pairs }
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
