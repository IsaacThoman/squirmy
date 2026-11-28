import { StreamQuality } from '@squirmy/contracts'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { z } from 'zod'

const flag = z.enum(['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off']).transform(value => ['1', 'true', 'yes', 'on'].includes(value))
const blank = (value: unknown) => (value === '' ? undefined : value)
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional())

/** A sample rate the speaker can open the sound card at. */
const Rate = z.coerce.number().int().min(8000).max(768_000)

/**
 * The speaker's settings, from the environment (see docs/server/speaker.md). Every one has a
 * default that works on a Raspberry Pi with one sound card, so none is required.
 */
const Environment = z.object({
  /** The server's address. Unset: the one paired with before, else the first found on the LAN. */
  SQUIRMY_SERVER: optional(z.url()),
  SQUIRMY_SPEAKER_NAME: optional(z.string().trim().min(1).max(80)),
  /** Where the device id and sign-in are kept. */
  SQUIRMY_SPEAKER_STATE_DIR: optional(z.string().min(1)),
  SQUIRMY_SPEAKER_OUTPUT: z.preprocess(blank, z.enum(['alsa', 'pulse', 'null']).default('alsa')),
  /** ALSA PCM (`hw:1,0`, `plughw:CARD=DAC`) or PulseAudio/PipeWire sink. Unset: the default device. */
  SQUIRMY_SPEAKER_DEVICE: optional(z.string().min(1)),
  /** `source` plays every song at its own rate; a number resamples everything to it. */
  SQUIRMY_SPEAKER_RATE: z.preprocess(blank, z.union([z.literal('source'), Rate]).default('source')),
  /** The highest rate the DAC takes: faster songs are resampled down to it. */
  SQUIRMY_SPEAKER_MAX_RATE: z.preprocess(blank, Rate.default(192_000)),
  SQUIRMY_SPEAKER_FORMAT: z.preprocess(blank, z.enum(['s32', 's16']).default('s32')),
  /** How far ahead of the speakers PCM is written, in milliseconds. */
  SQUIRMY_SPEAKER_BUFFER_MS: z.preprocess(blank, z.coerce.number().int().min(50).max(5000).default(300)),
  /** Unset: the account's Wi-Fi quality setting. */
  SQUIRMY_SPEAKER_QUALITY: optional(StreamQuality),
  /** An ALSA mixer control (`PCM`, `Digital`, `Master`) to turn for volume instead of scaling the samples. */
  SQUIRMY_SPEAKER_MIXER: optional(z.string().min(1)),
  SQUIRMY_SPEAKER_MIXER_CARD: optional(z.string().min(1)),
  /** The status page with the pairing code; 0 turns it and the LAN advertisement off. */
  SQUIRMY_SPEAKER_STATUS_PORT: z.preprocess(blank, z.coerce.number().int().min(0).max(65_535).default(4790)),
  /** Advertise the speaker and look for servers on the LAN with mDNS (Bonjour). */
  SQUIRMY_SPEAKER_MDNS: z.preprocess(blank, flag.default(true)),
  FFMPEG_PATH: optional(z.string().min(1)),
})

export type SpeakerConfig = {
  server: string | undefined
  name: string
  stateDir: string
  output: 'alsa' | 'pulse' | 'null'
  device: string | undefined
  rate: 'source' | number
  maxRate: number
  encoding: 's32le' | 's16le'
  bufferMs: number
  quality: StreamQuality | undefined
  mixer: { control: string; card: string | undefined } | null
  statusPort: number
  mdns: boolean
  ffmpegPath: string | undefined
}

function defaultStateDir(env: NodeJS.ProcessEnv): string {
  if (env.STATE_DIRECTORY) return env.STATE_DIRECTORY.split(':')[0]!
  return path.join(env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'squirmy-speaker')
}

/** Reads the configuration; throws with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpeakerConfig {
  const parsed = Environment.safeParse(env)
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')}`)
  }
  const value = parsed.data
  const machine = hostname().split('.')[0] || 'Linux'
  return {
    server: value.SQUIRMY_SERVER?.replace(/\/+$/, ''),
    name: value.SQUIRMY_SPEAKER_NAME ?? `Speaker (${machine})`.slice(0, 80),
    stateDir: value.SQUIRMY_SPEAKER_STATE_DIR ?? defaultStateDir(env),
    output: value.SQUIRMY_SPEAKER_OUTPUT,
    device: value.SQUIRMY_SPEAKER_DEVICE,
    rate: value.SQUIRMY_SPEAKER_RATE,
    maxRate: value.SQUIRMY_SPEAKER_MAX_RATE,
    encoding: value.SQUIRMY_SPEAKER_FORMAT === 's16' ? 's16le' : 's32le',
    bufferMs: value.SQUIRMY_SPEAKER_BUFFER_MS,
    quality: value.SQUIRMY_SPEAKER_QUALITY,
    mixer: value.SQUIRMY_SPEAKER_MIXER ? { control: value.SQUIRMY_SPEAKER_MIXER, card: value.SQUIRMY_SPEAKER_MIXER_CARD } : null,
    statusPort: value.SQUIRMY_SPEAKER_STATUS_PORT,
    mdns: value.SQUIRMY_SPEAKER_MDNS,
    ffmpegPath: value.FFMPEG_PATH,
  }
}
