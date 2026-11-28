import { audioQualityLabel, signalQuality, signalSections, versionQuality, versionTitle } from '@squirmy/client-core'
import { queryKeys, type SignalPath, type TrackVersion } from '@squirmy/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AudioLines, Check, CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { errorMessage } from '@/api/errors'
import { useApi } from '@/api/services'
import { Cover } from '@/components/music/Cover'
import { Spinner } from '@/components/ui/feedback'
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
            <VersionsSection
              trackId={item.track.id}
              albumId={item.entry.albumId ?? item.track.album?.id ?? null}
              playing={signal?.trackId === item.track.id ? signal.source?.versionId ?? null : null}
              onPicked={() => player.controls.forgetPlayback(item.track.id)}
            />
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

/**
 * The versions of the song the server holds (an edition in one quality tier), when there are
 * two or more: which one plays, and the user's pick for the song, which they can change.
 * Automatic plays the album's pick, else the best copy. A pick plays from the next time the
 * song starts; what plays now goes on.
 */
function VersionsSection({ trackId, albumId, playing, onPicked }: { trackId: string; albumId: string | null; playing: string | null; onPicked: () => void }) {
  const api = useApi()
  const queryClient = useQueryClient()
  const key = [...queryKeys.track(trackId), 'versions', albumId] as const
  const { data } = useQuery({ queryKey: key, queryFn: () => api.catalog.trackVersions(trackId, albumId ? { albumId } : {}) })
  const [pending, setPending] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ choice: string; message: string } | null>(null)
  if (!data || data.versions.length < 2) return null
  const choose = async (versionId: string | null) => {
    const choice = versionId ?? 'automatic'
    setPending(choice)
    setFailure(null)
    try {
      await (versionId === null ? api.catalog.clearVersion('track', trackId) : api.catalog.pickVersion('track', trackId, versionId))
      onPicked()
      await queryClient.invalidateQueries({ queryKey: key })
    } catch (error) {
      setFailure({ choice, message: errorMessage(error) })
    } finally {
      setPending(null)
    }
  }
  const choices: { id: string; title: string; detail: string; version: TrackVersion | null }[] = [
    { id: 'automatic', title: 'Automatic', detail: 'The album’s pick, else the best copy', version: null },
    ...data.versions.map(version => ({
      id: version.id,
      title: versionTitle(version),
      detail: [versionQuality(version.quality), version.albumId === albumId ? null : version.albumTitle].filter(Boolean).join(' · '),
      version,
    })),
  ]
  const picked = data.versionId ?? 'automatic'
  return (
    <section className="flex flex-col gap-1.5">
      <h3 id={`versions-${trackId}`} className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Versions</h3>
      <div role="radiogroup" aria-labelledby={`versions-${trackId}`} className="-mx-2 flex flex-col">
        {choices.map(choice => {
          const checked = picked === choice.id
          const failed = failure?.choice === choice.id
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-busy={pending === choice.id || undefined}
              disabled={pending !== null}
              onClick={() => { if (!checked) void choose(choice.version ? choice.id : null) }}
              className="flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default pointer-coarse:min-h-11"
            >
              <span className="mt-0.5 size-4 shrink-0 [&_svg]:size-4" aria-hidden>
                {pending === choice.id ? <Spinner label={null} className="size-4" /> : failed ? <CircleAlert className="text-destructive" /> : checked ? <Check className="text-primary" /> : null}
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{choice.title}</span>
                <span className="text-xs text-muted-foreground">{failed ? <span className="text-destructive">{failure.message}</span> : choice.detail}</span>
              </span>
              {choice.version && choice.id === playing && <span className="shrink-0 text-xs text-muted-foreground">Playing</span>}
            </button>
          )
        })}
      </div>
      <p className="text-xs text-muted-foreground">A version you pick plays from the next time the song starts.</p>
    </section>
  )
}
