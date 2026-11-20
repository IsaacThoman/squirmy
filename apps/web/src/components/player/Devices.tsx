import type { DeviceInfo } from '@squirmy/contracts'
import { AppWindow, Laptop, MonitorSpeaker, Smartphone, Speaker } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Player } from '@/player/player-context'
import { VolumeControl } from './Transport'

export function DeviceIcon({ kind, className }: { kind: DeviceInfo['kind']; className?: string }) {
  const Icon = kind === 'web' ? AppWindow : kind === 'desktop' ? Laptop : kind === 'ios' || kind === 'android' ? Smartphone : Speaker
  return <Icon aria-hidden className={className} />
}

function deviceName(device: DeviceInfo, thisDeviceId: string) {
  return device.id === thisDeviceId ? 'This browser' : device.name
}

/** "Listening on …" and the other places this session can play. */
export function DevicesPopover({ player, trigger, side = 'top' }: { player: Player; trigger: ReactNode; side?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side={side} align="end" aria-label="Playback devices">
        <DeviceList player={player} onTransferred={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** The device that plays, with its volume, and the devices playback can move to. */
export function DeviceList({ player, onTransferred }: { player: Player; onTransferred?: () => void }) {
  const { devices, activeDeviceId, thisDeviceId, volumes } = player.state
  const active = devices.find(device => device.id === activeDeviceId)
  const others = devices.filter(device => device.id !== activeDeviceId)
  const onTransfer = (deviceId: string) => {
    player.controls.transfer(deviceId)
    onTransferred?.()
  }
  return (
    <div>
      <div className="rounded-2xl bg-selection p-3.5">
        <div className="flex items-center gap-3.5">
          <div className="flex size-11 items-center justify-center rounded-xl bg-accent text-on-accent">
            {active ? <DeviceIcon kind={active.kind} className="size-5" /> : <MonitorSpeaker className="size-5" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-muted">Listening on</p>
            <p className="truncate text-[15px] font-bold text-accent">{active ? deviceName(active, thisDeviceId) : 'Nothing right now'}</p>
          </div>
        </div>
        {active && (
          <VolumeControl
            label={`${deviceName(active, thisDeviceId)} volume`}
            volume={volumes[active.id] ?? 1}
            onChange={volume => player.controls.setVolume(volume, active.id)}
            fill
            className="-mb-1 -ml-1.5 mt-2.5 pr-1"
          />
        )}
      </div>
      {others.length > 0 && <p className="px-3 pb-1 pt-3.5 text-xs font-semibold text-quiet">Play on another device</p>}
      <ul className="flex flex-col">
        {others.map(device => (
          <li key={device.id}>
            <button
                type="button"
                disabled={!device.canPlay}
                onClick={() => onTransfer(device.id)}
                className="flex w-full items-center gap-3.5 rounded-xl px-3 py-2.5 text-left transition-colors duration-100 hover:bg-overlay disabled:opacity-45"
              >
                <DeviceIcon kind={device.kind} className={cn('size-5 shrink-0', device.id === thisDeviceId ? 'text-accent' : 'text-muted')} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold" title={deviceName(device, thisDeviceId)}>{deviceName(device, thisDeviceId)}</span>
                  <span className="block truncate text-xs text-muted">{device.id === thisDeviceId ? 'Play in this tab' : device.canPlay ? deviceKind(device.kind) : 'Remote control only'}</span>
                </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function deviceKind(kind: DeviceInfo['kind']) {
  return { ios: 'iPhone app', android: 'Android app', web: 'Web browser', desktop: 'Computer', other: 'Speaker' }[kind]
}

/** Shown while another device plays: where the sound is, and a way to bring it here. */
export function PlayingElsewhere({ device, onPlayHere, className }: { device: DeviceInfo; onPlayHere: () => void; className?: string }) {
  return (
    <div className={cn('flex h-7 items-center justify-center gap-2 bg-accent px-4 text-[12px] font-semibold text-on-accent', className)}>
      <DeviceIcon kind={device.kind} className="size-3.5" />
      <span className="truncate">Playing on {device.name}</span>
      <button type="button" onClick={onPlayHere} className="ml-1 rounded-full px-2 py-0.5 font-bold underline-offset-2 hover:underline focus-visible:outline-on-accent">
        Play here
      </button>
    </div>
  )
}
