import { runFfprobe } from '../../lib/ffmpeg.js'
import { libraryPath } from './files.js'
import { codecFamily, mimeFor, type MediaFile } from './profiles.js'

type Probe = { streams?: { codec_type: string; duration_ts?: number; time_base?: string }[] }

/**
 * Older FFmpeg versions decode a whole last AAC packet even when MP4 gives it a
 * shorter duration. Check the exact track duration when the measurement ends on a
 * packet boundary without a reported discard. Keep the decode count if the header
 * is missing or disagrees by more than a coded packet.
 */
export async function fragmentedSourceFrames(file: MediaFile, input?: string): Promise<number | null> {
  const { decodedFrames: frames, decodedRate: rate, primingFrames, paddingFrames } = file
  if (!frames || !rate || primingFrames === null || paddingFrames !== 0 || (frames + primingFrames) % 1024 !== 0
    || codecFamily(file) !== 'aac' || mimeFor(file) !== 'audio/mp4') return frames
  let probe: Probe
  try {
    probe = await runFfprobe(input ?? await libraryPath(file), 'stream=codec_type,duration_ts,time_base') as Probe
  } catch {
    return frames
  }
  const audio = probe.streams?.find((stream) => stream.codec_type === 'audio')
  const timeBase = /^(\d+)\/(\d+)$/.exec(audio?.time_base ?? '')
  if (!timeBase || audio?.duration_ts === undefined) return frames
  const duration = audio.duration_ts * Number(timeBase[1]) * rate / Number(timeBase[2])
  if (!Number.isSafeInteger(duration) || duration <= 0 || frames - duration >= 2048) return frames
  return Math.min(duration, frames)
}
