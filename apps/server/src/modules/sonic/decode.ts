import { spawn } from 'node:child_process'
import { setPriority } from 'node:os'
import { getConfig } from '../../config.js'
import { audioInput } from '../../lib/ffmpeg.js'
import { SAMPLE_RATE, SonicAnalyzer, type SonicFeatures } from './dsp/analyzer.js'

/** Longer tracks (DJ mixes, live sets) are analysed for their first half hour only. */
export const MAX_ANALYSIS_SECONDS = 30 * 60
/** The lowest scheduling priority: decoding gives way to everything else on the machine. */
const DECODER_NICENESS = 19

/**
 * Decodes the file's first audio stream to mono float PCM at the analyzer's rate and runs
 * the analysis on it as it arrives. ffmpeg runs at the lowest CPU priority; the analysis
 * itself takes a few milliseconds per chunk on this process's event loop.
 */
export function analyzeAudioFile(file: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SonicFeatures | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(getConfig().FFMPEG_PATH, [
      '-v', 'error', '-nostdin', ...audioInput(file),
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-t', String(MAX_ANALYSIS_SECONDS),
      '-f', 'f32le', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal })
    try {
      if (child.pid) setPriority(child.pid, DECODER_NICENESS)
    } catch {
      // Some containers refuse priority changes; the decode then runs at normal priority.
    }
    const analyzer = new SonicAnalyzer()
    let carry: Buffer = Buffer.alloc(0)
    let stderr = ''
    let settled = false
    const finish = (error: Error | null, features?: SonicFeatures | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(features ?? null)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('Audio analysis timed out'))
    }, options.timeoutMs ?? 10 * 60_000)

    child.stdout.on('data', (chunk: Buffer) => {
      const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const usable = bytes.length - (bytes.length % 4)
      // Copy into an aligned buffer: a pipe chunk can start at any byte offset.
      const samples = new Float32Array(usable / 4)
      new Uint8Array(samples.buffer).set(bytes.subarray(0, usable))
      carry = bytes.subarray(usable)
      try {
        analyzer.push(samples)
      } catch (error) {
        child.kill('SIGKILL')
        finish(error as Error)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString()
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(stderr.trim().split('\n').at(-1) || `ffmpeg exited with ${code}`))
        return
      }
      try {
        finish(null, analyzer.finish())
      } catch (error) {
        finish(error as Error)
      }
    })
  })
}
