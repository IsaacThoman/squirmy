import type { EngineMedia } from '@squirmy/client-core'
import type { SpeakerConfig } from './config.js'
import type { PcmFormat } from './pcm.js'
import { alsaSink, nullSink, type PcmSink, pulseSink } from './sinks.js'

/** CD's rate, for a stream whose descriptor does not say. */
const FALLBACK_RATE = 44_100

/**
 * The format an entry plays in: stereo at the stream's own rate (bit-perfect when the DAC
 * takes it), or the configured fixed rate. A rate above what the DAC takes comes down to the
 * highest of its own family (176.4 kHz to 88.2 kHz, not 96), a whole-number ratio.
 */
export function outputFormat(config: Pick<SpeakerConfig, 'rate' | 'maxRate' | 'encoding'>, media: EngineMedia | undefined): PcmFormat {
  const source = media?.gapless?.sampleRate ?? media?.sampleRate ?? FALLBACK_RATE
  let rate = config.rate === 'source' ? source : config.rate
  if (rate > config.maxRate) {
    const family = rate % 44_100 === 0 ? 44_100 : rate % 48_000 === 0 ? 48_000 : null
    let lowered = family
    while (lowered && lowered * 2 <= config.maxRate) lowered *= 2
    rate = lowered && lowered <= config.maxRate ? lowered : config.maxRate
  }
  return { sampleRate: rate, channels: 2, encoding: config.encoding }
}

export function createSink(config: Pick<SpeakerConfig, 'output' | 'device' | 'bufferMs'>): PcmSink {
  // The device holds half the lead, so the engine's writes always run ahead of it.
  const options = { device: config.device, bufferMs: Math.max(20, Math.round(config.bufferMs / 2)) }
  if (config.output === 'pulse') return pulseSink(options)
  if (config.output === 'null') return nullSink()
  return alsaSink(options)
}
