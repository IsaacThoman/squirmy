import { listedDevices, reconnectingText, type SessionMoveResult } from '@squirmy/client-core'
import { queryKeys, type DeviceInfo } from '@squirmy/contracts'
import { useQuery } from '@tanstack/react-query'
import { AppWindow, Laptop, ListPlus, MonitorSpeaker, Smartphone, Speaker, Split, Unlink2, Users } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useApi } from '@/api/services'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatIdle } from '@/lib/format'
import { cn } from '@/lib/utils'
import { labelDevice, whereItPlays, type Player } from '@/player/player-context'
import { VolumeControl } from './Transport'

export function DeviceIcon({ kind, className }: { kind: DeviceInfo['kind']; className?: string }) {
  const Icon = kind === 'web' ? AppWindow : kind === 'desktop' ? Laptop : kind === 'ios' || kind === 'android' ? Smartphone : Speaker
  return <Icon aria-hidden className={className} />
}

/** "Listening on …" (or "Paused on …") and the other places this session can play. */
export function DevicesPopover({ player, trigger, side = 'top' }: { player: Player; trigger: ReactNode; side?: 'top' | 'bottom' }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        side={side}
        align="end"
        aria-label="Playback devices"
        // On a short screen (a phone on its side) the list scrolls inside the room there is, so its last action stays reachable.
        className="max-h-(--radix-popover-content-available-height) w-72 overflow-y-auto p-1"
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

/**
 * The device that plays, with its volume, and the devices playback can move to; then the
 * devices playing on their own, and a way for this tab to play separately. While this tab is
 * detached it shows that instead, with the ways back.
 */
export function DeviceList({ player, onTransferred }: { player: Player; onTransferred?: () => void }) {
  const { activeDeviceId, thisDeviceId, volumes, detached, canDetach } = player.state
  // One row per browser, not per tab (client-core `listedDevices`).
  const devices = listedDevices(player.state.devices, thisDeviceId)
  const name = (device: DeviceInfo) => labelDevice(player.state, device).name
  // A detached device plays its own queue: it is listed apart, and playback never moves to it.
  const separate = devices.filter(device => device.detached && device.id !== thisDeviceId)
  const shared = devices.filter(device => !device.detached)
  const active = shared.find(device => device.id === activeDeviceId)
  const others = shared.filter(device => device.id !== activeDeviceId)
  // The device that plays went away: it is not offered anywhere, only waited for, until the
  // session lets it go or it comes back.
  const away = player.state.away?.id === activeDeviceId ? player.state.away : null
  const onTransfer = (deviceId: string) => {
    player.controls.transfer(deviceId)
    onTransferred?.()
  }
  if (detached) return <DetachedList player={player} separate={separate} onDone={onTransferred} />
  return (
    <div>
      <div className="px-2 pb-1.5 pt-2">
        <div className="flex items-center gap-3">
          <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', active ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground')}>
            {active ? <DeviceIcon kind={active.kind} className="size-4" /> : away?.device ? <DeviceIcon kind={away.device.kind} className="size-4" /> : <MonitorSpeaker aria-hidden className="size-4" />}
          </div>
          <div className="min-w-0">
            {/* Never "listening" to a session that is paused: Play here and the picker keep it paused. */}
            <p className="text-xs text-muted-foreground">{active && !player.state.playing ? 'Paused on' : 'Listening on'}</p>
            {away
              ? <p className="truncate text-sm font-medium" role="status">{reconnectingText(away.device ? labelDevice(player.state, away.device) : null)}</p>
              : <p className={cn('truncate text-sm font-medium', active && 'text-primary')}>{active ? name(active) : 'Nothing right now'}</p>}
          </div>
        </div>
        {active && (
          <VolumeControl
            label={`${name(active)} volume`}
            volume={volumes[active.id] ?? 1}
            deviceId={active.id}
            onChange={volume => player.controls.setVolume(volume, active.id)}
            fill
            className="-ml-1.5 mt-1.5 gap-2.5 pr-1"
          />
        )}
      </div>
      {others.length > 0 && (
        <div className="mt-1 border-t pt-1">
          <GroupLabel>Play on another device</GroupLabel>
          <ul>
            {others.map(device => (
              <li key={device.id}>
                <button
                  type="button"
                  disabled={!device.canPlay}
                  onClick={() => onTransfer(device.id)}
                  {...(device.id === thisDeviceId && { onPointerEnter: player.controls.prepareHere, onPointerDown: player.controls.prepareHere, onFocus: player.controls.prepareHere })}
                  className={rowClass}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground"><DeviceIcon kind={device.kind} className="size-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" title={name(device)}>{name(device)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{deviceDetail(player, device)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <PlayingSeparately player={player} devices={separate} />
      {/* Hidden, not disabled, where it cannot work: a tab that only controls, or an older server. */}
      {canDetach && (
        <div className="mt-1 border-t pt-1">
          <ActionRow
            icon={<Split className="size-4" />}
            title="Play separately on this tab"
            detail="Your other devices keep their own queue."
            onClick={async () => {
              const playing = player.state.playing && player.state.activeDeviceId === thisDeviceId
              const result = await player.controls.detach()
              // Said on the player's status line, which stays in sight as the picker closes.
              if (!result.ok) return player.controls.tell({ message: moveError(result, 'Couldn’t play separately.'), tone: 'error' })
              // The player then says "Only on this device"; what it did to the other devices is said here.
              if (playing) player.controls.tell({ message: 'Playing only on this device', detail: 'Your other devices are paused where they were.', tone: 'info' })
              onTransferred?.()
            }}
          />
        </div>
      )}
    </div>
  )
}

/** This tab plays its own queue: what it plays, and the ways back to the other devices. */
function DetachedList({ player, separate, onDone }: { player: Player; separate: DeviceInfo[]; onDone?: () => void }) {
  const { current, queue, playing, volumes, thisDeviceId } = player.state
  // The server refuses to bring an empty session (`nothing_to_bring`), so it is not offered.
  const hasQueue = Boolean(current) || queue.length > 0
  const rejoin = async (bringQueue: boolean) => {
    const stopped = !bringQueue && playing ? current?.track.title : undefined
    const result = await player.controls.attach(bringQueue ? { bringQueue: true } : undefined)
    if (!result.ok) return player.controls.tell({ message: moveError(result, 'Couldn’t rejoin.'), tone: 'error' })
    // Rejoining drops this tab's queue, so say what stopped; it cannot be had back.
    if (stopped) player.controls.tell({ message: 'Rejoined your other devices', detail: `Stopped “${stopped}”.`, tone: 'info' })
    onDone?.()
  }
  return (
    <div>
      <div className="px-2 pb-1.5 pt-2">
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"><Unlink2 aria-hidden className="size-4" /></div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">{playing ? 'Playing only on this device' : 'Only on this device'}</p>
            <p className="truncate text-xs text-muted-foreground">{current ? current.track.title : 'Nothing playing'}</p>
          </div>
        </div>
        <VolumeControl
          label="This browser volume"
          volume={volumes[thisDeviceId] ?? 1}
          deviceId={thisDeviceId}
          onChange={volume => player.controls.setVolume(volume, thisDeviceId)}
          fill
          className="-ml-1.5 mt-1.5 gap-2.5 pr-1"
        />
      </div>
      <div className="mt-1 border-t pt-1">
        <ActionRow icon={<Users className="size-4" />} title="Rejoin your other devices" onClick={() => void rejoin(false)} />
        {hasQueue && (
          <ActionRow icon={<ListPlus className="size-4" />} title="Bring this queue with me" detail="Your other devices switch to what’s playing here." onClick={() => void rejoin(true)} />
        )}
      </div>
      <PlayingSeparately player={player} devices={separate} />
    </div>
  )
}

/**
 * The devices playing their own queue, each with what it plays. Shown on every device, so
 * whoever wonders why the kitchen did not change finds out here. Not pressable.
 */
function PlayingSeparately({ player, devices }: { player: Player; devices: DeviceInfo[] }) {
  if (!devices.length) return null
  return (
    <div className="mt-1 border-t pt-1">
      <GroupLabel>Playing separately</GroupLabel>
      <ul>
        {devices.map(device => (
          <li key={device.id} className="flex items-center gap-3 px-2 py-1.5">
            <span className="flex size-9 shrink-0 items-center justify-center text-muted-foreground"><DeviceIcon kind={device.kind} className="size-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm" title={labelDevice(player.state, device).name}>{labelDevice(player.state, device).name}</span>
              <span className="block truncate text-xs text-muted-foreground"><SeparateTrack state={device.detached!} /></span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** What a detached device plays, by title, and "· Paused" while it does not. */
function SeparateTrack({ state }: { state: NonNullable<DeviceInfo['detached']> }) {
  const api = useApi()
  const { trackId, albumId } = state
  const track = useQuery({
    queryKey: [...queryKeys.track(trackId ?? ''), albumId],
    queryFn: () => api.catalog.track(trackId!, { albumId: albumId ?? undefined }),
    enabled: Boolean(trackId),
  }).data
  if (!trackId) return <>Nothing playing</>
  // Until (or unless) the song is known, what it is doing still says something.
  if (!track) return <>{state.playing ? 'Playing' : 'Paused'}</>
  return <>{track.title}{!state.playing && ' · Paused'}</>
}

// Focus is the shared ring, drawn inside the row so the popover's edge does not clip it.
const rowClass = 'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50'

function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="px-2 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{children}</p>
}

function ActionRow({ icon, title, detail, onClick }: { icon: ReactNode; title: string; detail?: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={rowClass}>
      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{title}</span>
        {detail && <span className="block text-xs text-muted-foreground">{detail}</span>}
      </span>
    </button>
  )
}

/** What a refused detach or attach says. `fallback` covers errors with nothing to add. */
function moveError(result: Extract<SessionMoveResult, { ok: false }>, fallback: string): string {
  if (result.error === 'offline') return 'Can’t do that while offline.'
  if (result.error === 'too_many_detached') return 'Eight devices are already playing separately. Re-attach one first.'
  if (result.error === 'timeout' || result.error === 'disconnected' || result.error === 'internal_error') return `${fallback} Try again.`
  return fallback
}

/** A row's second line: what the device is and how long it has been quiet, plus what tells it from a twin. */
function deviceDetail(player: Player, device: DeviceInfo) {
  const label = labelDevice(player.state, device)
  if (label.relation === 'this') return 'Play in this tab'
  if (label.relation === 'tab') return `Open in this browser${formatIdle(device.lastSeenAt)}`
  const what = device.canPlay ? deviceKind(device.kind) : 'Remote control only'
  return `${what}${formatIdle(device.lastSeenAt)}${label.hint ? ` · ${label.hint}` : ''}`
}

function deviceKind(kind: DeviceInfo['kind']) {
  return { ios: 'iPhone app', android: 'Android app', web: 'Web browser', desktop: 'Computer', other: 'Speaker' }[kind]
}

/** Shown while another device plays: where the sound is, and a way to bring it here. */
export function PlayingElsewhere({ player, device, onPlayHere, onPrepare, className }: { player: Player; device: DeviceInfo; onPlayHere: () => void; onPrepare?: () => void; className?: string }) {
  return (
    // The words are in the text color: the action color on its own tint is under 4.5:1 in several light themes.
    // Play here keeps a paused session paused, as moving the music anywhere does; the words say "Paused on …".
    <div className={cn('flex h-8 items-center justify-center gap-1.5 bg-primary/10 px-4 text-xs font-medium text-foreground', className)}>
      <DeviceIcon kind={device.kind} className="size-3.5 shrink-0 text-primary" />
      <span className="truncate">{whereItPlays(player.state, device)}</span>
      {/* Pointing at it is reason enough to get the music ready: it is usually pressed next. Its
          hit area reaches past the 32px strip to a 44px target for a finger. */}
      <button type="button" onClick={onPlayHere} onPointerEnter={onPrepare} onPointerDown={onPrepare} onFocus={onPrepare} className="relative ml-1.5 h-6 shrink-0 after:absolute after:-inset-x-1 after:-inset-y-2.5 rounded-md bg-primary px-2 text-primary-foreground outline-none transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background">
        Play here
      </button>
    </div>
  )
}

/**
 * Shown while this tab is detached, where "Playing on …" would be: it plays its own queue.
 * A choice, not an error, so in the theme's color; pressing it opens the devices picker,
 * where rejoining is.
 */
export function OnlyOnThisDevice({ player, className }: { player: Player; className?: string }) {
  return (
    <DevicesPopover
      player={player}
      trigger={(
        <button type="button" className={cn('flex h-8 w-full items-center justify-center gap-1.5 bg-primary/10 px-4 text-xs font-medium text-foreground outline-none transition-colors hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', className)}>
          <Unlink2 aria-hidden className="size-3.5 shrink-0 text-primary" />
          Only on this device
        </button>
      )}
    />
  )
}
