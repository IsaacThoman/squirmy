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
      <PopoverContent
        side={side}
        align="end"
        aria-label="Playback devices"
        className="w-72 p-1"
        // Focus goes to the popover, not to its first button: that would raise the mute button's tooltip over the list.
        onOpenAutoFocus={event => {
          event.preventDefault()
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus()
        }}
      >
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
      <div className="px-2 pb-1.5 pt-2">
        <div className="flex items-center gap-3">
          <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', active ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground')}>
            {active ? <DeviceIcon kind={active.kind} className="size-4" /> : <MonitorSpeaker aria-hidden className="size-4" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Listening on</p>
            <p className={cn('truncate text-sm font-medium', active && 'text-primary')}>{active ? deviceName(active, thisDeviceId) : 'Nothing right now'}</p>
          </div>
        </div>
        {active && (
          <VolumeControl
            label={`${deviceName(active, thisDeviceId)} volume`}
            volume={volumes[active.id] ?? 1}
            onChange={volume => player.controls.setVolume(volume, active.id)}
            fill
            className="-ml-1.5 mt-1.5 gap-2.5 pr-1"
          />
        )}
      </div>
      {others.length > 0 && (
        <div className="mt-1 border-t pt-1">
          <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Play on another device</p>
          <ul>
            {others.map(device => (
              <li key={device.id}>
                <button
                  type="button"
                  disabled={!device.canPlay}
                  onClick={() => onTransfer(device.id)}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:opacity-50"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground"><DeviceIcon kind={device.kind} className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" title={deviceName(device, thisDeviceId)}>{deviceName(device, thisDeviceId)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{device.id === thisDeviceId ? 'Play in this tab' : device.canPlay ? deviceKind(device.kind) : 'Remote control only'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function deviceKind(kind: DeviceInfo['kind']) {
  return { ios: 'iPhone app', android: 'Android app', web: 'Web browser', desktop: 'Computer', other: 'Speaker' }[kind]
}

/** Shown while another device plays: where the sound is, and a way to bring it here. */
export function PlayingElsewhere({ device, onPlayHere, className }: { device: DeviceInfo; onPlayHere: () => void; className?: string }) {
  return (
    <div className={cn('flex h-8 items-center justify-center gap-1.5 bg-primary/10 px-4 text-xs font-medium text-primary', className)}>
      <DeviceIcon kind={device.kind} className="size-3.5 shrink-0" />
      <span className="truncate">Playing on {device.name}</span>
      <button type="button" onClick={onPlayHere} className="ml-1.5 h-6 shrink-0 rounded-md bg-primary px-2 text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background">
        Play here
      </button>
    </div>
  )
}
