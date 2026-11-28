import { audioQualityLabel, signalQuality, signalSections } from '@squirmy/client-core'
import type { SignalPath } from '@squirmy/contracts'
import { AudioLines } from 'lucide-react'
import { Cover } from '@/components/music/Cover'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/feedback'
import { cn } from '@/lib/utils'
import { labelDevice, type Player } from '@/player/player-context'

/**
 * "Lossless" or "Hi-Res Lossless" for what reaches the device that plays, as music apps badge
 * it under the seek bar; nothing for a lossy stream, the ordinary case. It opens Track info.
 */
export function QualityBadge({ signal, onOpen, className }: { signal: SignalPath | null | undefined; onOpen: () => void; className?: string }) {
  const quality = signalQuality(signal)
  if (!quality) return null
  const label = audioQualityLabel(quality)
  return (
    <button type="button" aria-haspopup="dialog" aria-label={`${label}, track info`} onClick={onOpen} className={cn('group rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}>
      <Badge tone="outline" className="border-current/25 bg-transparent px-1.5 py-px text-[11px] transition-colors group-hover:text-foreground">
        <AudioLines aria-hidden />
        {label}
      </Badge>
    </button>
  )
}

/** Where the current song plays, as the devices list names it. */
function playingOn(player: Player): string | null {
  const { activeDeviceId, devices, thisDeviceId, away } = player.state
  if (activeDeviceId === null) return null
  const device = devices.find(item => item.id === activeDeviceId) ?? (away?.id === activeDeviceId ? away.device : null)
  if (activeDeviceId === thisDeviceId) return 'This browser'
  return device ? labelDevice(player.state, device).name : 'Another device'
}

/**
 * Track info: the song, the file it plays from, how that reaches the device (the file as it is,
 * or a transcode and why), the volume normalization applied, and which device plays it. The
 * audio facts are the playing device's own report, so they hold for a TV this tab controls.
 */
export function TrackInfoDialog({ player, open, onOpenChange }: { player: Player; open: boolean; onOpenChange: (open: boolean) => void }) {
  const item = player.state.current
  const signal = player.state.signal ?? null
  const device = playingOn(player)
  const elsewhere = player.state.activeDeviceId !== null && player.state.activeDeviceId !== player.state.thisDeviceId
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Track info" className="sm:max-w-sm">
        {item ? (
          <>
            <div className="flex items-center gap-3">
              <Cover artwork={item.track.album?.artwork ?? null} size={96} className="size-12 shrink-0 rounded-md" />
              <div className="min-w-0">
                <p className="truncate font-medium">{item.track.title}</p>
                <p className="truncate text-sm text-muted-foreground">{item.track.artistCredit}</p>
                {item.track.album && <p className="truncate text-sm text-muted-foreground">{item.track.album.title}</p>}
              </div>
            </div>
            {device && <InfoSection title="Playing on" rows={[{ label: 'Device', value: device }]} />}
            {signal
              ? signalSections(signal).map(section => <InfoSection key={section.title} {...section} />)
              : (
                  <p className="text-sm text-muted-foreground">
                    {elsewhere
                      ? `${device ?? 'The device playing'} hasn’t said how it plays this song. It may need an update.`
                      : device ? 'Loading the song…' : 'Play the song to see how it plays.'}
                  </p>
                )}
          </>
        ) : <p className="text-sm text-muted-foreground">Nothing playing.</p>}
      </DialogContent>
    </Dialog>
  )
}

function InfoSection({ title, rows }: { title: string; rows: { label: string; value: string }[] }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(row => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
