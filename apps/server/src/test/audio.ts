import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export type ToneFormat = 'flac' | 'mp3' | 'm4a' | 'ogg' | 'opus' | 'wav'

export type ToneSpec = {
  /** Output path relative to the directory passed to makeTone; the extension picks the format. */
  path: string
  durationSec?: number
  frequency?: number
  /** Level of the tone. Keep it very quiet: tests play these out loud. */
  volumeDb?: number
  /** Written as-is with `-metadata`. Use the container's own tag names (e.g. MUSICBRAINZ_ALBUMID). */
  tags?: Record<string, string | number>
  /** Embed a small solid-color cover. */
  cover?: boolean | string
}

const codecs: Record<ToneFormat, string[]> = {
  flac: ['-c:a', 'flac'],
  mp3: ['-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3'],
  m4a: ['-c:a', 'aac', '-b:a', '128k'],
  ogg: ['-c:a', 'libvorbis', '-q:a', '3'],
  opus: ['-c:a', 'libopus', '-b:a', '64k'],
  wav: ['-c:a', 'pcm_s16le'],
}

/** Writes one short sine tone with the given tags and returns its absolute path. */
export async function makeTone(directory: string, spec: ToneSpec): Promise<string> {
  const output = path.join(directory, spec.path)
  const format = path.extname(output).slice(1) as ToneFormat
  if (!codecs[format]) throw new Error(`Unsupported fixture format: ${format}`)
  await mkdir(path.dirname(output), { recursive: true })

  const duration = spec.durationSec ?? 2
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${spec.frequency ?? 440}:duration=${duration}:sample_rate=44100`]
  const withCover = spec.cover && (format === 'flac' || format === 'mp3' || format === 'm4a')
  if (withCover) {
    const color = typeof spec.cover === 'string' ? spec.cover : 'purple'
    args.push('-f', 'lavfi', '-i', `color=c=${color}:s=96x96:d=1`, '-map', '0:a', '-map', '1:v', '-frames:v', '1', '-c:v', 'mjpeg', '-disposition:v', 'attached_pic')
  }
  args.push('-af', `volume=${spec.volumeDb ?? -50}dB`, '-ac', '2', ...codecs[format])
  for (const [key, value] of Object.entries(spec.tags ?? {})) args.push('-metadata', `${key}=${value}`)
  args.push(output)
  await run(process.env.FFMPEG_PATH ?? 'ffmpeg', args)
  return output
}

export type AlbumSpec = {
  artist: string
  album: string
  year?: number
  genre?: string
  format?: ToneFormat
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
