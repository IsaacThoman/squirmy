import type { EngineEvent, EngineStatus } from '@squirmy/client-core'
import { AudioLines } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { Page, PageHeader } from '@/components/layout/Page'
import { Button } from '@/components/ui/button'
import { Badge, EmptyState } from '@/components/ui/feedback'
import { Row, Section } from '@/components/ui/section'
import { Slider } from '@/components/ui/slider'
import { formatDuration } from '@/lib/format'
import { useEngineOverride } from '@/player/engine/engine-context'
import { MediaSessionAdapter } from '@/player/engine/media-session'
import { WebPlayerEngine } from '@/player/engine/web-engine'

const tones = [
  { id: 'a', label: 'Tone A', detail: '440 Hz, 4 s', durationMs: 4000 },
  { id: 'b', label: 'Tone B', detail: '660 Hz, 3 s', durationMs: 3000 },
  { id: 'c', label: 'Tone C', detail: '550 Hz, 1.5 s', durationMs: 1500 },
]
const url = (name: string) => `/dev-audio/${name}.flac`
const mediaTracks = new Map(tones.map(tone => [tone.id, { title: `${tone.label} (${tone.detail})`, artist: 'Squirmy test tones', album: 'Engine check', artwork: [] }]))

type LoggedEvent = { at: number; event: EngineEvent }

/** What the end-to-end check reads and drives through `window.squirmyEngine`. */
type Instruments = {
  engine: WebPlayerEngine
  events: LoggedEvent[]
  /** RMS of the engine's output right now, after every gain stage. */
  level: () => number
}

declare global {
  interface Window { squirmyEngine?: Instruments }
}

let created: Instruments | null = null

/**
 * An engine whose output runs through an analyser, so its level can be measured. Created
 * on first use and kept for the page load, so leaving and reopening the page reuses it.
 */
function instrumentedEngine(): Instruments {
  if (created) return created
  let analyser: AnalyserNode | null = null
  const engine = new WebPlayerEngine({
    output: context => {
      analyser = context.createAnalyser()
      analyser.fftSize = 4096
      analyser.connect(context.destination)
      return analyser
    },
  })
  const events: LoggedEvent[] = []
  engine.subscribe(event => events.push({ at: performance.now(), event }))
  const level = () => {
    if (!analyser) return 0
    const samples = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(samples)
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
  }
  created = { engine, events, level }
  return created
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
    void fetch(url('a'), { method: 'HEAD' }).then(response => setTonesReady(response.ok), () => setTonesReady(false))
  }, [])

  return (
    <>
      <PageHeader title="Audio engine" />
      <Page className="flex max-w-3xl flex-col gap-7">
        <p className="max-w-xl text-sm text-muted-foreground">Drives the browser engine with generated test tones. Every event the engine emits is logged below.</p>
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

  const load = (name: string, autoplay: boolean) => {
    setToneId(name)
    engine.load({ entryId: `${name}-${Date.now()}`, url: url(name), startMs: 0, autoplay, gain })
  }
  const duration = tones.find(tone => tone.id === toneId)?.durationMs ?? 0

  // `?autoplay=a` starts a tone with no click first, as when a tab reopens mid-session. Scripts
  // reach the blocked-audio state this way; anything they evaluate in the page counts as a gesture.
  const autoplayTone = useSearchParams()[0].get('autoplay')
  useEffect(() => {
    if (autoplayTone) engine.load({ entryId: `${autoplayTone}-autoplay`, url: url(autoplayTone), startMs: 0, autoplay: true, gain: 1 })
  }, [engine, autoplayTone])

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
            <Button size="sm" variant="ghost" onClick={() => engine.preload({ entryId: `${tone.id}-next-${Date.now()}`, url: url(tone.id), gain })}>Preload</Button>
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
