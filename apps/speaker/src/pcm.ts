/**
 * Raw PCM as the speaker moves it: interleaved, little-endian, signed integers. 32-bit is the
 * default because every source fits it exactly (16- and 24-bit samples are shifted up, which
 * the DAC undoes by ignoring the low bits), so a song at unity gain reaches the sound card
 * with every bit it had.
 */
export type PcmEncoding = 's16le' | 's32le'

export type PcmFormat = { sampleRate: number; channels: number; encoding: PcmEncoding }

export const bytesPerSample = (encoding: PcmEncoding) => (encoding === 's16le' ? 2 : 4)
export const bytesPerFrame = (format: PcmFormat) => format.channels * bytesPerSample(format.encoding)
export const sameFormat = (a: PcmFormat, b: PcmFormat) =>
  a.sampleRate === b.sampleRate && a.channels === b.channels && a.encoding === b.encoding

export const framesIn = (chunk: Buffer, format: PcmFormat) => Math.floor(chunk.length / bytesPerFrame(format))
export const framesToMs = (frames: number, sampleRate: number) => (frames * 1000) / sampleRate
export const msToFrames = (ms: number, sampleRate: number) => Math.round((ms * sampleRate) / 1000)

/**
 * Scales samples by `gain`, ramping it up from 0 over the first `fadeFrames` frames (the
 * de-click fade of a start that is not gapless). Returns `chunk` itself, untouched, at unity
 * gain without a fade: that is the bit-perfect path. Gains above 1 clip at full scale; the
 * session never asks for one that reaches it on a song whose peak is known, since the speaker
 * says it has no limiter (`gainFor` then holds the gain back to `1 / peak`).
 */
export function applyGain(chunk: Buffer, format: PcmFormat, gain: number, fade?: { done: number; frames: number }): Buffer {
  const fading = fade !== undefined && fade.done < fade.frames
  if (gain === 1 && !fading) return chunk
  const out = Buffer.allocUnsafe(chunk.length)
  const wide = format.encoding === 's32le'
  const size = bytesPerSample(format.encoding)
  const max = wide ? 2_147_483_647 : 32_767
  const min = wide ? -2_147_483_648 : -32_768
  const channels = format.channels
  const frames = framesIn(chunk, format)
  for (let frame = 0; frame < frames; frame++) {
    let level = gain
    if (fade && fade.done < fade.frames) level *= fade.done++ / fade.frames
    for (let channel = 0; channel < channels; channel++) {
      const offset = (frame * channels + channel) * size
      const sample = wide ? chunk.readInt32LE(offset) : chunk.readInt16LE(offset)
      const scaled = Math.max(min, Math.min(max, Math.round(sample * level)))
      if (wide) out.writeInt32LE(scaled, offset)
      else out.writeInt16LE(scaled, offset)
    }
  }
  return out
}

/** Splits `chunk` after `frames` frames. */
export function splitAt(chunk: Buffer, format: PcmFormat, frames: number): [Buffer, Buffer] {
  const bytes = Math.min(chunk.length, frames * bytesPerFrame(format))
  return [chunk.subarray(0, bytes), chunk.subarray(bytes)]
}
