import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'
import { planDecode } from './decoder.js'
import { outputFormat } from './output.js'
import { applyGain, type PcmFormat } from './pcm.js'

const wide: PcmFormat = { sampleRate: 44_100, channels: 2, encoding: 's32le' }
const narrow: PcmFormat = { sampleRate: 44_100, channels: 2, encoding: 's16le' }

const s32 = (...samples: number[]) => {
  const buffer = Buffer.alloc(samples.length * 4)
  samples.forEach((sample, index) => buffer.writeInt32LE(sample, index * 4))
  return buffer
}
const read32 = (buffer: Buffer) => Array.from({ length: buffer.length / 4 }, (_, index) => buffer.readInt32LE(index * 4))

describe('applyGain', () => {
  it('passes samples through untouched at unity gain', () => {
    const chunk = s32(1, -2, 2_000_000_000, -2_147_483_648)
    expect(applyGain(chunk, wide, 1)).toBe(chunk)
  })

  it('scales, and clips at full scale rather than wrapping', () => {
    expect(read32(applyGain(s32(1000, -1000, 2_000_000_000, -2_000_000_000), wide, 0.5))).toEqual([500, -500, 1_000_000_000, -1_000_000_000])
    expect(read32(applyGain(s32(2_000_000_000, -2_000_000_000), wide, 2))).toEqual([2_147_483_647, -2_147_483_648])
    const quiet = Buffer.alloc(4)
    quiet.writeInt16LE(30_000, 0)
    quiet.writeInt16LE(-30_000, 2)
    const loud = applyGain(quiet, narrow, 2)
    expect([loud.readInt16LE(0), loud.readInt16LE(2)]).toEqual([32_767, -32_768])
  })

  it('fades in across chunks', () => {
    const fade = { done: 0, frames: 4 }
    expect(read32(applyGain(s32(400, 400, 400, 400), wide, 1, fade))).toEqual([0, 0, 100, 100])
    expect(read32(applyGain(s32(400, 400, 400, 400, 400, 400), wide, 1, fade))).toEqual([200, 200, 300, 300, 400, 400])
    const after = s32(400, 400)
    expect(applyGain(after, wide, 1, fade)).toBe(after)
  })
})

describe('planDecode', () => {
  const request = (media: Parameters<typeof planDecode>[0]['media'], startFrame = 0, sampleRate = 44_100) =>
    planDecode({ url: 'http://server/stream', startFrame, format: { ...wide, sampleRate }, media })

  it('lets ffmpeg apply an original’s own gapless data and cuts at its measured length', () => {
    expect(request({ transcoded: false, profile: 'original', codec: 'mp3', gapless: { sampleRate: 44_100, primingFrames: 1105, frames: 100_000 } }))
      .toEqual({ fragmented: false, priming: 0, limit: 100_000, tolerance: 11_025 })
  })

  it('drops a fragmented transcode’s priming, except Opus’s, which ffmpeg drops itself', () => {
    expect(request({ transcoded: true, profile: 'aac_mp4_256', codec: 'aac', gapless: { sampleRate: 44_100, primingFrames: 1024, frames: 100_000 } }))
      .toMatchObject({ fragmented: true, priming: 1024, limit: 100_000 })
    expect(request({ transcoded: true, profile: 'opus_mp4_192', codec: 'opus', gapless: { sampleRate: 48_000, primingFrames: 312, frames: 108_844 } }, 0, 48_000))
      .toMatchObject({ fragmented: true, priming: 0, limit: 108_844 })
    expect(request({ transcoded: true, profile: 'flac_mp4', codec: 'flac', gapless: { sampleRate: 96_000, primingFrames: 0, frames: 960_000 } }, 96_000, 96_000))
      .toMatchObject({ fragmented: true, priming: 0, limit: 864_000 })
  })

  it('scales the numbers when it resamples, and has no limit without them', () => {
    expect(request({ transcoded: true, profile: 'flac_mp4', codec: 'flac', gapless: { sampleRate: 96_000, primingFrames: 0, frames: 960_000 } }, 0, 48_000))
      .toMatchObject({ limit: 480_000 })
    expect(request({ transcoded: false, profile: 'original' })).toMatchObject({ priming: 0, limit: null })
  })
})

describe('outputFormat', () => {
  const config = { rate: 'source' as const, maxRate: 192_000, encoding: 's32le' as const }

  it('plays each song at its own rate, or the fixed one', () => {
    expect(outputFormat(config, { transcoded: false, sampleRate: 96_000 })).toEqual({ sampleRate: 96_000, channels: 2, encoding: 's32le' })
    expect(outputFormat(config, { transcoded: true, sampleRate: 44_100, gapless: { sampleRate: 48_000, primingFrames: 0, frames: 1 } }).sampleRate).toBe(48_000)
    expect(outputFormat(config, undefined).sampleRate).toBe(44_100)
    expect(outputFormat({ ...config, rate: 48_000 }, { transcoded: false, sampleRate: 44_100 }).sampleRate).toBe(48_000)
  })

  it('brings a rate above the DAC’s down within its family', () => {
    const dac = { ...config, maxRate: 96_000 }
    expect(outputFormat(dac, { transcoded: false, sampleRate: 176_400 }).sampleRate).toBe(88_200)
    expect(outputFormat(dac, { transcoded: false, sampleRate: 192_000 }).sampleRate).toBe(96_000)
    expect(outputFormat({ ...config, maxRate: 32_000 }, { transcoded: false, sampleRate: 44_100 }).sampleRate).toBe(32_000)
  })
})

describe('loadConfig', () => {
  it('works with nothing set', () => {
    const config = loadConfig({ HOME: '/home/pi' })
    expect(config).toMatchObject({ server: undefined, output: 'alsa', rate: 'source', encoding: 's32le', bufferMs: 300, statusPort: 4790, mdns: true, mixer: null })
    expect(config.stateDir).toMatch(/\/\.local\/state\/squirmy-speaker$/)
    expect(loadConfig({ XDG_STATE_HOME: '/state' }).stateDir).toBe('/state/squirmy-speaker')
  })

  it('reads every setting, and systemd’s state directory', () => {
    const config = loadConfig({
      SQUIRMY_SERVER: 'http://music.local:4747/', SQUIRMY_SPEAKER_NAME: 'Den', SQUIRMY_SPEAKER_OUTPUT: 'pulse', SQUIRMY_SPEAKER_RATE: '48000',
      SQUIRMY_SPEAKER_FORMAT: 's16', SQUIRMY_SPEAKER_MIXER: 'Digital', SQUIRMY_SPEAKER_MIXER_CARD: '1', SQUIRMY_SPEAKER_MDNS: 'off',
      SQUIRMY_SPEAKER_STATUS_PORT: '0', STATE_DIRECTORY: '/var/lib/squirmy-speaker',
    })
    expect(config).toMatchObject({
      server: 'http://music.local:4747', name: 'Den', output: 'pulse', rate: 48_000, encoding: 's16le',
      mixer: { control: 'Digital', card: '1' }, mdns: false, statusPort: 0, stateDir: '/var/lib/squirmy-speaker',
    })
  })

  it('names every bad setting', () => {
    expect(() => loadConfig({ SQUIRMY_SPEAKER_OUTPUT: 'jack', SQUIRMY_SPEAKER_RATE: 'fast' })).toThrow(/SQUIRMY_SPEAKER_OUTPUT[\s\S]*SQUIRMY_SPEAKER_RATE/)
  })
})
