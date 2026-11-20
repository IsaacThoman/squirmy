import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getConfig } from '../config.js'

const exec = promisify(execFile)

export type ToolResult = { stdout: string; stderr: string }

/** Runs ffmpeg with `-v error -nostdin` and the given arguments. Rejects on a non-zero exit. */
export async function runFfmpeg(args: readonly string[], options: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<ToolResult> {
  return exec(getConfig().FFMPEG_PATH, ['-v', 'error', '-nostdin', ...args], {
    timeout: options.timeoutMs ?? 10 * 60_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  })
}

/** Runs ffprobe and returns its JSON output for the given file. */
export async function runFfprobe(file: string, entries = 'format:stream'): Promise<unknown> {
  const { stdout } = await exec(getConfig().FFPROBE_PATH, ['-v', 'error', '-of', 'json', '-show_entries', entries, file], {
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
  const { stdout } = await runFfmpeg(['-i', file, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'])
  const match = /SHA256=([0-9a-f]{64})/i.exec(stdout)
  if (!match?.[1]) throw new Error(`ffmpeg did not return an audio hash for ${file}`)
  return match[1].toLowerCase()
}
