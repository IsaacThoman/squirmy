import { useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Row } from '@/components/ui/section'
import { Select, type SelectOption } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { setAudioSettings, useAudioSettings } from '@/player/audio-settings'
import { CROSSFADE_SECONDS } from '@/player/engine/crossfade-engine'
import { EQ_BANDS, EQ_MAX_DB, EQ_PRESETS, eqGains, type EqPreset } from '@/player/engine/equalizer'

const presetOptions: SelectOption<EqPreset>[] = [
  ...EQ_PRESETS.map(preset => ({ value: preset.id, label: preset.label })),
  { value: 'custom', label: 'Custom' },
]

// The select's values are strings; the setting is a number of seconds.
const crossfadeOptions: SelectOption<string>[] = CROSSFADE_SECONDS.map(seconds => ({ value: String(seconds), label: seconds ? `${seconds} seconds` : 'Off' }))

/** Radix's select has no empty value, which is `setSinkId`'s default. */
const DEFAULT_DEVICE = 'default'

const formatGain = (gain: number) => (gain > 0 ? `+${gain}` : gain < 0 ? `−${-gain}` : '0')
const formatBand = (frequency: number) => (frequency >= 1000 ? `${frequency / 1000}k` : String(frequency))

/** Settings → Playback, for this browser: crossfade, the equalizer and, where the browser can send Web Audio to one (`choosesOutput`), the output device. */
export function SoundSettings({ choosesOutput }: { choosesOutput: boolean }) {
  const { equalizer, outputDevice, crossfadeSeconds, smartTransitions } = useAudioSettings()
  const gains = eqGains(equalizer)
  const bandsLabel = useId()
  return (
    <>
      <Row htmlFor="crossfade" label="Crossfade" description="Fades each song into the next. Songs of an album played in order still follow each other without a gap. Kept in this browser.">
        <Select id="crossfade" label="Crossfade" value={String(crossfadeSeconds)} options={crossfadeOptions} onValueChange={seconds => setAudioSettings({ crossfadeSeconds: Number(seconds) })} className="w-40" />
      </Row>
      {crossfadeSeconds > 0 && (
        <Row htmlFor="smart-transitions" label="Smart transitions" description="Fits each crossfade to the songs: a song that fades out is blended over its fade-out, one that ends abruptly is cut close to the next, within the length above. Silence at either end is always skipped.">
          <Switch id="smart-transitions" checked={smartTransitions} onCheckedChange={on => setAudioSettings({ smartTransitions: on })} />
        </Row>
      )}
      <Row htmlFor="equalizer" label="Equalizer" description="Shapes the sound for the speakers or headphones this browser plays through. Kept in this browser.">
        <Select id="equalizer" label="Equalizer" value={equalizer.preset} options={presetOptions} onValueChange={preset => setAudioSettings({ equalizer: { ...equalizer, preset } })} className="w-40" />
      </Row>
      {equalizer.preset !== 'off' && (
        <div role="group" aria-labelledby={bandsLabel} className="rounded-lg border p-3">
          <div id={bandsLabel} className="sr-only">Equalizer bands</div>
          <div className="grid grid-cols-10 gap-0.5 @sm:gap-1">
            {EQ_BANDS.map((frequency, index) => (
              <Band
                key={frequency}
                frequency={frequency}
                gain={gains[index] ?? 0}
                // Moving a band of a preset starts your own from it.
                onChange={gain => setAudioSettings({ equalizer: { preset: 'custom', custom: gains.map((value, band) => (band === index ? gain : value)) } })}
              />
            ))}
          </div>
        </div>
      )}
      {choosesOutput && <OutputDevice value={outputDevice} />}
    </>
  )
}

function Band({ frequency, gain, onChange }: { frequency: number; gain: number; onChange: (gain: number) => void }) {
  const name = frequency >= 1000 ? `${frequency / 1000} kHz` : `${frequency} Hz`
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <span aria-hidden className="text-xs tabular text-muted-foreground">{formatGain(gain)}</span>
      <div className="h-28">
        <Slider label={name} orientation="vertical" min={-EQ_MAX_DB} max={EQ_MAX_DB} step={0.5} value={gain} valueText={`${formatGain(gain)} dB`} onValueChange={onChange} />
      </div>
      <span aria-hidden className="text-xs tabular">{formatBand(frequency)}</span>
    </div>
  )
}

type OutputDevices = { devices: { id: string; label: string }[]; named: boolean }

/** The audio outputs the browser names to the page. Without a permission it names none. */
async function listOutputs(): Promise<OutputDevices> {
  const all = await navigator.mediaDevices.enumerateDevices()
  // "default" and "communications" are the system's choices, which "System default" already is.
  const outputs = all.filter(device => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default' && device.deviceId !== 'communications')
  return { devices: outputs.map(device => ({ id: device.deviceId, label: device.label || 'Output device' })), named: outputs.some(device => device.label) }
}

type AudioOutputPicker = { selectAudioOutput?: () => Promise<MediaDeviceInfo> }

function OutputDevice({ value }: { value: string }) {
  const [outputs, setOutputs] = useState<OutputDevices | null>(null)
  const [refused, setRefused] = useState(false)
  useEffect(() => {
    const media = navigator.mediaDevices
    if (!media?.enumerateDevices) return
    let live = true
    const refresh = () => listOutputs().then(next => { if (live) setOutputs(next) }, () => {})
    refresh()
    media.addEventListener?.('devicechange', refresh)
    return () => {
      live = false
      media.removeEventListener?.('devicechange', refresh)
    }
  }, [])

  // Where the browser has its own device chooser, it asks nothing more; elsewhere the page may
  // list outputs only once it may use the microphone, which is stopped as soon as it is granted.
  const findDevices = async () => {
    setRefused(false)
    const media = navigator.mediaDevices as MediaDevices & AudioOutputPicker
    try {
      if (media.selectAudioOutput) {
        const chosen = await media.selectAudioOutput()
        setAudioSettings({ outputDevice: chosen.deviceId })
      } else {
        const stream = await media.getUserMedia({ audio: true })
        for (const track of stream.getTracks()) track.stop()
      }
      setOutputs(await listOutputs())
    } catch {
      setRefused(true)
    }
  }

  const devices = outputs?.devices ?? []
  const known = devices.some(device => device.id === value)
  const options: SelectOption<string>[] = [{ value: DEFAULT_DEVICE, label: 'System default' }, ...devices.map(device => ({ value: device.id, label: device.label }))]
  const description = refused
    ? 'Your browser didn’t allow it, so Squirmy plays through the system’s output.'
    : outputs?.named
      ? 'Where this browser plays music. Kept in this browser.'
      : 'Your browser names its speakers and headphones only to sites that may use the microphone. Squirmy turns the microphone off at once and records nothing.'
  const listed = Boolean(outputs?.named || known)
  return (
    <Row htmlFor={listed ? 'output-device' : undefined} label="Output" description={description}>
      {listed ? (
        <Select
          id="output-device"
          label="Output"
          value={known ? value : DEFAULT_DEVICE}
          options={options}
          onValueChange={next => setAudioSettings({ outputDevice: next === DEFAULT_DEVICE ? '' : next })}
          className="w-52"
        />
      ) : (
        <Button size="sm" variant="outline" onClick={() => void findDevices()}>Choose a device</Button>
      )}
    </Row>
  )
}
