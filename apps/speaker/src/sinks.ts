import { type ChildProcess, spawn } from 'node:child_process'
import type { PcmFormat } from './pcm.js'

/**
 * Where PCM goes: the sound card. The engine opens it in a format, writes paced PCM (a fraction
 * of a second ahead of what plays), and closes it to stop at once: closing drops whatever the
 * device has not played yet. A new format (another sample rate) means closing and opening again.
 */
export interface PcmSink {
  open(format: PcmFormat, onError: (error: Error) => void): void
  write(chunk: Buffer): void
  close(): void
}

export type SinkOptions = {
  /** ALSA PCM (`default`, `hw:1,0`, `plughw:CARD=DAC`) or PulseAudio/PipeWire sink name. Unset: the system default. */
  device?: string
  /** How much the device itself buffers, in milliseconds. */
  bufferMs: number
}

/**
 * `aplay` from alsa-utils. It needs no daemon and no native build, and with a `hw:` device the
 * samples reach the DAC untouched at the stream's own rate (`plughw:` converts when the DAC
 * cannot take the rate or format).
 */
export function alsaSink(options: SinkOptions): PcmSink {
  return new ProcessSink(format => ['aplay', [
    '-q', '-t', 'raw', '-f', format.encoding === 's16le' ? 'S16_LE' : 'S32_LE', '-c', String(format.channels), '-r', String(format.sampleRate),
    `--buffer-time=${options.bufferMs * 1000}`, ...(options.device ? ['-D', options.device] : []),
  ]])
}

/** `pacat` from pulseaudio-utils, for desktops and boxes that run PulseAudio or PipeWire (through pipewire-pulse). */
export function pulseSink(options: SinkOptions): PcmSink {
  return new ProcessSink(format => ['pacat', [
    '--playback', '--raw', `--format=${format.encoding}`, `--channels=${format.channels}`, `--rate=${format.sampleRate}`,
    `--latency-msec=${options.bufferMs}`, '--client-name=Squirmy', '--stream-name=Squirmy speaker',
    ...(options.device ? [`--device=${options.device}`] : []),
  ]])
}

/** Discards everything: for trying the speaker on a machine without a sound card. */
export function nullSink(): PcmSink {
  return { open() {}, write() {}, close() {} }
}

class ProcessSink implements PcmSink {
  private child: ChildProcess | null = null

  constructor(private readonly command: (format: PcmFormat) => [string, string[]]) {}

  open(format: PcmFormat, onError: (error: Error) => void): void {
    this.close()
    const [file, args] = this.command(format)
    const child = spawn(file, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    this.child = child
    let errors = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (text: string) => { errors = (errors + text).slice(-1000) })
    child.stdin!.on('error', () => {})
    const failed = (error: Error) => {
      if (this.child !== child) return
      this.child = null
      onError(error)
    }
    child.on('error', error => failed(error))
    child.on('close', code => failed(new Error(errors.trim().split('\n').pop() || `${file} exited with ${code}`)))
  }

  write(chunk: Buffer): void {
    this.child?.stdin?.write(chunk)
  }

  close(): void {
    const child = this.child
    this.child = null
    child?.kill('SIGKILL')
  }
}
