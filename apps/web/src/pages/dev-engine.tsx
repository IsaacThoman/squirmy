import type { EngineEvent, EngineMedia, EngineStatus } from '@squirmy/client-core'
import { AudioLines } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { Page, PageHeader } from '@/components/layout/Page'
import { Button } from '@/components/ui/button'
import { Badge, EmptyState } from '@/components/ui/feedback'
import { Row, Section } from '@/components/ui/section'
import { Slider } from '@/components/ui/slider'
import { formatDuration } from '@/lib/format'
import { playsGaplessThroughMse } from '@/player/engine/choose'
import { setAudioSettings } from '@/player/audio-settings'
import { CrossfadeEngine } from '@/player/engine/crossfade-engine'
import { useEngineOverride } from '@/player/engine/engine-context'
import { MediaSessionAdapter } from '@/player/engine/media-session'
import { MseEngine } from '@/player/engine/mse-engine'
import { OutputChain } from '@/player/engine/output'
import type { BrowserEngine } from '@/player/engine/types'
import { WebPlayerEngine } from '@/player/engine/web-engine'

const tones = [
  { id: 'a', label: 'Tone A', detail: '440 Hz, 4 s', durationMs: 4000 },
  { id: 'b', label: 'Tone B', detail: '660 Hz, 3 s', durationMs: 3000 },
  { id: 'c', label: 'Tone C', detail: '550 Hz, 1.5 s', durationMs: 1500 },
  { id: 'd', label: 'Tone D', detail: '880 Hz, 8 s', durationMs: 8000 },
  { id: 'e', label: 'Tone E', detail: '330 Hz, 8 s', durationMs: 8000 },
]
const mediaTracks = new Map(tones.map(tone => [tone.id, { title: `${tone.label} (${tone.detail})`, artist: 'Squirmy test tones', album: 'Engine check', artwork: [] }]))
const TONE_RATE = 44_100

type LoggedEvent = { at: number; event: EngineEvent }

/** A tone to load: the element plays the FLAC as it is; MSE gets it in fragmented MP4, with its exact length. */
type Source = { url: string; media?: EngineMedia }

/** What the end-to-end check reads and drives through `window.squirmyEngine`. */
type Instruments = {
  engine: BrowserEngine
  kind: 'mse' | 'web'
  events: LoggedEvent[]
  /** RMS of the engine's output right now, after every gain stage. */
  level: () => number
  /** Where tone `name` is served for this engine. */
  source: (name: string) => Source
  /** The output's sample rate, once the audio context exists. */
  sampleRate: () => number | null
  /**
   * Records the engine's output through an AudioWorklet until `stop`, which resolves with
   * each channel as base64 of 32-bit floats. Null until the worklet has loaded.
   */
  recorder: (() => { stop: () => Promise<[string, string]> }) | null
  /** The MSE engine's timeline and buffered ranges. */
  inspect?: () => unknown
  /** Renders a test signal through the output chain, limiter and equalizer included, offline: sample for sample, and silent. */
  offline: (request: OfflineRequest) => Promise<OfflineResult>
}

/**
 * A full-scale sine (`frequency`, starting at `phase`) or a sweep (220 to 1760 Hz on the left,
 * 1320 to 330 Hz on the right), at `levelDb`, played through a gain of `gain` into the chain.
 */
type OfflineRequest = {
  signal: { kind: 'tone'; frequency: number; phase?: number } | { kind: 'sweep' }
  rate: number
  seconds: number
  levelDb: number
  /** Linear, as an entry's gain is. */
  gain: number
  /** Equalizer bands in dB; flat without. */
  equalizer?: number[]
}

/** What went into the chain and what came out (with the limiter's delay of silence first), each channel as base64 of 32-bit floats. */
type OfflineResult = { input: [string, string]; output: [string, string] }

declare global {
  interface Window { squirmyEngine?: Instruments }
}

let created: Instruments | null = null

function toneMedia(name: string): EngineMedia {
  const durationMs = tones.find(tone => tone.id === name)?.durationMs ?? 1000
  const frames = Math.round(durationMs * TONE_RATE / 1000)
  return { transcoded: true, profile: 'flac_mp4', mime: 'audio/mp4', codec: 'flac', sampleRate: TONE_RATE, durationMs, gapless: { sampleRate: TONE_RATE, primingFrames: 0, frames } }
}

/** `?engine=mse` or `web` picks the engine; by default, the one this browser gets. */
function engineKind(params: URLSearchParams): 'mse' | 'web' {
  const asked = params.get('engine')
  if (asked === 'mse' || asked === 'web') return asked
  return playsGaplessThroughMse(navigator) && MseEngine.isSupported() ? 'mse' : 'web'
}

function base64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let text = ''
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(text)
}

/**
 * An engine whose output runs through an analyser and a recorder, so its level and its
 * samples can be measured. Created on first use and kept for the page load, so leaving and
 * reopening the page reuses it. `?rate=` sets the output's sample rate (a recording at the
 * stream's own rate is not resampled); `?lead=` and `?behind=` shrink the MSE engine's
 * buffer, so short tones reach seeks outside it; `?muted=1` silences what follows the
 * recorder, so a measurement makes no sound; `?limiter=0` leaves the limiter out, to compare;
 * `?crossfade=` sets this browser's crossfade setting, in seconds, and `?smart=1` turns Smart
 * transitions on, which the page's engine follows as the app's does. The engine is the page's kind twice over in a `CrossfadeEngine`,
 * as the app's is.
 */
function instrumentedEngine(): Instruments {
  if (created) return created
  const params = new URLSearchParams(location.search)
  const kind = engineKind(params)
  const rate = Number(params.get('rate')) || undefined
  const muted = params.get('muted') === '1'
  const limiter = params.get('limiter') !== '0'
  let analyser: AnalyserNode | null = null
  let context: AudioContext | null = null
  const options = {
    ...limiter ? {} : { limiter: false },
    createContext: () => new AudioContext(rate ? { sampleRate: rate } : undefined),
    output: (created: AudioContext) => {
      context = created
      analyser = created.createAnalyser()
      analyser.fftSize = 4096
      analyser.connect(created.destination)
      void created.audioWorklet?.addModule(new URL('./dev-engine-recorder.js', import.meta.url)).then(() => {
        const recorder = new AudioWorkletNode(created, 'squirmy-recorder', { channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2] })
        const volume = created.createGain()
        volume.gain.value = muted ? 0 : 1
        analyser!.disconnect()
        analyser!.connect(recorder).connect(volume).connect(created.destination)
        instruments.recorder = () => record(recorder)
      }, () => {})
      return analyser
    },
  }
  const engine = new CrossfadeEngine({
    ...options,
    createEngine: shared => kind === 'mse'
      ? new MseEngine({ ...shared, leadSeconds: Number(params.get('lead')) || undefined, keepBehindSeconds: Number(params.get('behind')) || undefined })
      : new WebPlayerEngine(shared),
  })
  const crossfade = params.get('crossfade')
  if (crossfade !== null) setAudioSettings({ crossfadeSeconds: Number(crossfade) || 0 })
  const smart = params.get('smart')
  if (smart !== null) setAudioSettings({ smartTransitions: smart === '1' })
  const events: LoggedEvent[] = []
  engine.subscribe(event => events.push({ at: performance.now(), event }))
  const level = () => {
    if (!analyser) return 0
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
  }
  const source = (name: string): Source => kind === 'mse' ? { url: `/dev-audio/${name}.mp4`, media: toneMedia(name) } : { url: `/dev-audio/${name}.flac` }
  const instruments: Instruments = {
    engine, kind, events, level, source, recorder: null,
    sampleRate: () => (context as AudioContext | null)?.sampleRate ?? null,
    inspect: kind === 'mse' ? () => (engine.activeEngine() as MseEngine).inspect() : undefined,
    offline: renderOffline,
  }
  created = instruments
  return created
}

async function renderOffline({ signal, rate, seconds, levelDb, gain: entryGain, equalizer }: OfflineRequest): Promise<OfflineResult> {
  const frames = Math.round(rate * seconds)
  // Room after the signal for what the limiter holds back.
  const context = new OfflineAudioContext(2, frames + 1024, rate)
  const buffer = context.createBuffer(2, frames, rate)
  const level = 10 ** (levelDb / 20)
  const [left, right] = [buffer.getChannelData(0), buffer.getChannelData(1)]
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / rate
    if (signal.kind === 'tone') {
      left[frame] = right[frame] = level * Math.sin(2 * Math.PI * signal.frequency * t + (signal.phase ?? 0))
    } else {
      left[frame] = level * Math.sin(2 * Math.PI * (220 * t + (1760 - 220) / (2 * seconds) * t * t))
      right[frame] = level * Math.sin(2 * Math.PI * (1320 * t + (330 - 1320) / (2 * seconds) * t * t))
    }
  }
  let chain: OutputChain | null = null
  await new Promise<void>(resolve => { chain = new OutputChain(context, context.destination, { onLimiterChange: resolve }) })
  if (!chain!.limiting) throw new Error('The limiter did not load')
  chain!.setEqualizer(equalizer ?? null)
  const source = context.createBufferSource()
  source.buffer = buffer
  const gain = context.createGain()
  gain.gain.value = entryGain
  source.connect(gain).connect(chain!.input)
  source.start()
  const rendered = await context.startRendering()
  return {
    input: [base64(buffer.getChannelData(0)), base64(buffer.getChannelData(1))],
    output: [base64(rendered.getChannelData(0)), base64(rendered.getChannelData(1))],
  }
}

function record(node: AudioWorkletNode): { stop: () => Promise<[string, string]> } {
  const blocks: [Float32Array, Float32Array][] = []
  let stopped: (() => void) | null = null
  node.port.onmessage = ({ data }: MessageEvent<[Float32Array, Float32Array] | 'stopped'>) => {
    if (data === 'stopped') stopped?.()
    else blocks.push(data)
  }
  node.port.postMessage('start')
  return {
    stop: async () => {
      await new Promise<void>(resolve => {
        stopped = resolve
        node.port.postMessage('stop')
      })
      const frames = blocks.reduce((sum, [left]) => sum + left.length, 0)
      const channels = [new Float32Array(frames), new Float32Array(frames)]
      let offset = 0
      for (const [left, right] of blocks) {
        channels[0]!.set(left, offset)
        channels[1]!.set(right, offset)
        offset += left.length
      }
      return [base64(channels[0]!), base64(channels[1]!)]
    },
  }
}

/**
 * Hidden page for checking the browser engine against the `PlayerEngine` contract by hand
 * or from scripts/e2e-engine.mjs. Plays the tones from scripts/dev-audio.mjs.
 */
export function EnginePage() {
  const instruments = instrumentedEngine()
  const [tonesReady, setTonesReady] = useState<boolean | null>(null)

  useEffect(() => {
    window.squirmyEngine = instruments
    return () => {
      instruments.engine.stop()
      delete window.squirmyEngine
    }
  }, [instruments])

  useEffect(() => {
    void fetch(instruments.source('a').url, { method: 'HEAD' }).then(response => setTonesReady(response.ok), () => setTonesReady(false))
  }, [instruments])

  return (
    <>
      <PageHeader title="Audio engine" />
      <Page className="flex max-w-3xl flex-col gap-7">
        <p className="max-w-xl text-sm text-muted-foreground">
          Drives the browser engine ({instruments.kind === 'mse' ? 'one timeline through Media Source Extensions' : 'two audio elements'}) with generated test tones. Every event the engine emits is logged below.
        </p>
        {tonesReady === false && (
          <EmptyState icon={<AudioLines />} title="No test tones" description="Run npm run dev-audio -w @squirmy/web, then open this page on the Vite dev server." className="rounded-xl border py-10" />
        )}
        <EngineControls instruments={instruments} />
      </Page>
    </>
  )
}

function EngineControls({ instruments }: { instruments: Instruments }) {
  const { engine } = instruments
  useEngineOverride(engine)
  const [status, setStatus] = useState<EngineStatus>(() => engine.getStatus())
  const [level, setLevel] = useState(0)
  const [log, setLog] = useState<LoggedEvent[]>([])
  const [gain, setGain] = useState(1)
  const [toneId, setToneId] = useState<string | null>(null)

  useEffect(() => engine.subscribe(() => setLog(instruments.events.slice(-40).reverse())), [engine, instruments])

  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      setStatus(engine.getStatus())
      setLevel(instruments.level())
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [engine, instruments])

  // The page stands in for the session: system media controls call its buttons' actions.
  useEffect(() => {
    const media = new MediaSessionAdapter({
      play: () => engine.play(),
      pause: () => engine.pause(),
      next: () => {},
      previous: () => engine.seek(0),
      seek: positionMs => engine.seek(positionMs),
    })
    const update = () => {
      const current = engine.getStatus()
      const tone = tones.find(candidate => current.entryId?.startsWith(candidate.id))
      media.update({
        track: (tone && mediaTracks.get(tone.id)) ?? null,
        playing: current.state === 'playing' || current.state === 'buffering',
        positionMs: current.positionMs,
        durationMs: tone?.durationMs ?? 0,
      })
    }
    const unsubscribe = engine.subscribe(update)
    return () => {
      unsubscribe()
      media.dispose()
    }
  }, [engine])

  const { source } = instruments
  const load = (name: string, autoplay: boolean) => {
    setToneId(name)
    engine.load({ entryId: `${name}-${Date.now()}`, ...source(name), startMs: 0, autoplay, gain })
  }
  const duration = tones.find(tone => tone.id === toneId)?.durationMs ?? 0

  // `?autoplay=a` starts a tone with no click first, as when a tab reopens mid-session. Scripts
  // reach the blocked-audio state this way; anything they evaluate in the page counts as a gesture.
  const autoplayTone = useSearchParams()[0].get('autoplay')
  useEffect(() => {
    if (autoplayTone) engine.load({ entryId: `${autoplayTone}-autoplay`, ...source(autoplayTone), startMs: 0, autoplay: true, gain: 1 })
  }, [engine, source, autoplayTone])

  return (
    <>
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4">
        <Readout label="State"><Badge tone={status.state === 'error' ? 'danger' : status.state === 'playing' ? 'accent' : 'neutral'}>{status.state}</Badge></Readout>
        <Readout label="Entry"><span className="truncate font-mono text-xs">{status.entryId ?? '—'}</span></Readout>
        <Readout label="Position"><span className="text-lg font-semibold tabular">{formatDuration(status.positionMs)}.{String(status.positionMs % 1000).padStart(3, '0')}</span></Readout>
        <Readout label="Output level">
          <span className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${Math.min(100, level * 2500)}%` }} /></span>
        </Readout>
      </div>

      <Section title="Load">
        {tones.map(tone => (
          <Row key={tone.id} label={tone.label} description={tone.detail}>
            <Button size="sm" variant="outline" onClick={() => load(tone.id, false)}>Load</Button>
            <Button size="sm" onClick={() => load(tone.id, true)}>Load and play</Button>
            <Button size="sm" variant="ghost" onClick={() => engine.preload({ entryId: `${tone.id}-next-${Date.now()}`, ...source(tone.id), gain })}>Preload</Button>
          </Row>
        ))}
        <Row label="Failures" description="A missing file and a file that is not audio.">
          <Button size="sm" variant="outline" onClick={() => load('missing', true)}>Missing</Button>
          <Button size="sm" variant="outline" onClick={() => load('broken', true)}>Not audio</Button>
        </Row>
      </Section>

      <Section title="Transport">
        <Row label="Play state">
          <Button size="sm" variant="primary" onClick={() => engine.play()}>Play</Button>
          <Button size="sm" onClick={() => engine.pause()}>Pause</Button>
          <Button size="sm" variant="outline" onClick={() => engine.stop()}>Stop</Button>
        </Row>
        <Row label="Seek">
          <Button size="sm" variant="outline" onClick={() => engine.seek(engine.getStatus().positionMs - 1000)}>−1 s</Button>
          <Button size="sm" variant="outline" onClick={() => engine.seek(engine.getStatus().positionMs + 1000)}>+1 s</Button>
          <Button size="sm" variant="outline" disabled={!duration} onClick={() => engine.seek(duration - 1000)}>Last second</Button>
        </Row>
        <Row label="Preload" description="Plays after the loaded tone ends.">
          <Button size="sm" variant="outline" onClick={() => engine.preload(null)}>Clear preload</Button>
        </Row>
        <Row label="Gain" description="Above 100% boosts through Web Audio.">
          <div className="flex w-56 items-center gap-3">
            <Slider label="Gain" value={gain * 100} max={200} step={5} valueText={`${Math.round(gain * 100)}%`} onValueChange={value => { setGain(value / 100); engine.setGain(value / 100) }} />
            <span className="w-12 text-right text-sm font-medium tabular">{Math.round(gain * 100)}%</span>
          </div>
        </Row>
      </Section>

      <Section title="Events" description="Newest first.">
        {log.length === 0 && <Row label="Nothing yet" description="Load a tone." />}
        {log.length > 0 && (
          <ol className="-mx-4 max-h-80 overflow-y-auto px-4 font-mono text-xs leading-6 [scrollbar-width:thin]">
            {log.map(({ at, event }, index) => (
              <li key={`${at}-${index}`} className="flex gap-3">
                <span className="w-16 shrink-0 text-right text-muted-foreground tabular">{Math.round(at)}</span>
                <span className="truncate">{describe(event)}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  )
}

function Readout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-card p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex min-h-7 items-center">{children}</span>
    </div>
  )
}

function describe(event: EngineEvent): string {
  if (event.type === 'status') return `status ${event.status.state} ${event.status.entryId ?? '—'} @${event.status.positionMs}`
  if (event.type === 'ended') return `ended ${event.entryId}`
  return `error ${event.entryId}: ${event.message}`
}
