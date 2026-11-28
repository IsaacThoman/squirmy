import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getConfig } from '../config.js'

const exec = promisify(execFile)

export type ToolResult = { stdout: string; stderr: string }

/**
 * Demuxers for the scanner's audio extensions (`library/walk.ts`), as ffmpeg names them.
 * ffmpeg picks a demuxer by content, not by name, so without this a file called
 * `x.flac` that holds a concat script, a playlist or an SDP description makes it open
 * other files or sockets. `mov` covers mp4 and m4a, `asf` wma, `w64` the long form of
 * wav; `matroska` is here because some tools save WebM audio as `.opus` or `.ogg`.
 */
export const AUDIO_DEMUXERS = ['mp3', 'flac', 'mov', 'aac', 'ogg', 'wav', 'w64', 'aiff', 'wv', 'ape', 'asf', 'dsf', 'matroska'] as const

/**
 * Input options for a file ffmpeg or ffprobe reads on someone else's behalf: only local
 * files, only audio demuxers. Every input is an absolute path, so no other protocol is
 * needed; the whitelist also binds whatever the demuxer itself would open.
 */
export const INPUT_GUARD: readonly string[] = ['-protocol_whitelist', 'file', '-format_whitelist', AUDIO_DEMUXERS.join(',')]

/** `-i file` with the input guard in front; use it for every library or uploaded file. */
export const audioInput = (file: string): string[] => [...INPUT_GUARD, '-i', file]

/** Runs ffmpeg with `-v error -nostdin` and the given arguments. Rejects on a non-zero exit. */
export async function runFfmpeg(args: readonly string[], options: { timeoutMs?: number; maxBuffer?: number; lowPriority?: boolean } = {}): Promise<ToolResult> {
  const ffmpeg = getConfig().FFMPEG_PATH
  const nice = options.lowPriority && process.platform !== 'win32'
  return exec(nice ? '/usr/bin/nice' : ffmpeg, [...(nice ? ['-n', '15', ffmpeg] : []), '-v', 'error', '-nostdin', ...args], {
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  })
}

/** Runs ffprobe and returns its JSON output for the given file. */
export async function runFfprobe(file: string, entries = 'format:stream'): Promise<unknown> {
  const { stdout } = await exec(getConfig().FFPROBE_PATH, ['-v', 'error', ...INPUT_GUARD, '-of', 'json', '-show_entries', entries, file], {
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(stdout)
}

/**
 * SHA-256 of the first audio stream's packets, read without decoding.
 *
 * Tags, embedded pictures and the file's name are not part of the stream, so the hash
 * survives retagging and moving. It is how a file keeps its identity.
 */
export async function audioHash(file: string): Promise<string> {
  const { stdout } = await runFfmpeg([...audioInput(file), '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])
  return readAudioHash(stdout, file)
}

export function readAudioHash(stdout: string, file: string): string {
  const match = /SHA256=([0-9a-f]{64})/i.exec(stdout)
  if (!match?.[1]) throw new Error(`ffmpeg did not return an audio hash for ${file}`)
  return match[1].toLowerCase()
}
