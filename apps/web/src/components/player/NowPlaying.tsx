import { ChevronDown, Heart, ListMusic, MessageSquareQuote, MonitorSpeaker } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Link } from 'react-router'
import { Cover } from '@/components/music/Cover'
import { Dialog } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { useArtUrl } from '@/lib/artwork'
import { cn } from '@/lib/utils'
import { playingElsewhere, type Player } from '@/player/player-context'
import { STILL_LOADING_LABEL, useStillLoading } from '@/player/use-still-loading'
import { DevicesPopover, PlayingElsewhere } from './Devices'
import { LyricsPane } from './Lyrics'
import { QueueContent } from './Queue'
import { SeekBar, TransportButtons, VolumeControl } from './Transport'

export type NowPlayingPane = 'art' | 'lyrics' | 'queue'

type NowPlayingProps = {
  player: Player
  open: boolean
  onOpenChange: (open: boolean) => void
  pane: NowPlayingPane
  onPaneChange: (pane: NowPlayingPane) => void
  liked: boolean
  onToggleLike: () => void
}

/** The theme's background over the blurred artwork: a tint at the top, solid under the controls. */
const wash = 'linear-gradient(to bottom, color-mix(in srgb, var(--background) 55%, transparent), color-mix(in srgb, var(--background) 80%, transparent) 40%, var(--background))'

/** Full-screen player: big artwork over a blur of itself, with lyrics or the queue beside it. */
export function NowPlaying({ player, open, onOpenChange, pane, onPaneChange, liked, onToggleLike }: NowPlayingProps) {
  const { state, controls } = player
  const artUrl = useArtUrl()
  const item = state.current
  const artwork = item?.track.album?.artwork ?? null
  const elsewhere = playingElsewhere(state)
  const late = useStillLoading(item?.entry)
  const toggle = (next: NowPlayingPane) => onPaneChange(pane === next ? 'art' : next)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-40 flex animate-slide-in flex-col overflow-clip bg-background pt-[env(safe-area-inset-top)] text-foreground outline-none data-[state=closed]:animate-exit"
        >
          <div aria-hidden className="absolute inset-0">
            {artwork && (
              // Held toward the theme's background, darker in dark mode, so the theme's text stays readable over any cover.
              <div className="absolute inset-0 opacity-50 saturate-200 dark:opacity-70 dark:brightness-60" style={{ backgroundColor: artwork.color ?? undefined }}>
                <img src={artUrl(artwork, 300)} alt="" className="absolute inset-[-10%] size-[120%] max-w-none object-cover blur-[70px]" />
              </div>
            )}
            <div className="absolute inset-0" style={{ backgroundImage: wash }} />
          </div>

          {elsewhere && <PlayingElsewhere device={elsewhere} onPlayHere={() => controls.transfer(state.thisDeviceId)} className="relative" />}

          <div className="relative flex h-14 shrink-0 items-center justify-between gap-3 px-3 md:px-5">
            <DialogPrimitive.Close asChild>
              <IconButton label="Close Now Playing" tooltip={false} className="text-foreground max-md:size-11"><ChevronDown /></IconButton>
            </DialogPrimitive.Close>
            <div className="min-w-0 text-center">
              {state.context?.title && (
                <>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Playing from {state.context.type}</p>
                  <p className="truncate text-sm font-medium">{state.context.title}</p>
                </>
              )}
            </div>
            <DevicesPopover
              side="bottom"
              player={player}
              trigger={<IconButton label="Devices" className={cn('max-md:size-11', elsewhere ? 'text-primary hover:text-primary' : 'text-foreground')}><MonitorSpeaker /></IconButton>}
            />
          </div>

          <DialogPrimitive.Title className="sr-only">Now Playing</DialogPrimitive.Title>

          <div className={cn('relative grid min-h-0 flex-1 grid-cols-1 gap-8 px-6 py-4 md:px-8 lg:gap-12 lg:px-10', pane !== 'art' && 'lg:grid-cols-2')}>
            {/* A size container, so the artwork is the largest square that fits the space left. */}
            <div className={cn('min-h-0 min-w-0 items-center justify-center [container-type:size]', pane === 'art' ? 'flex' : 'hidden lg:flex')}>
              <Cover artwork={artwork} size={1200} className="size-[min(100cqw,100cqh,34rem)] rounded-xl shadow-[0_32px_80px_-24px_rgb(0_0_0/0.6)]" />
            </div>
            {pane !== 'art' && (
              // Alone, the pane is as wide as the controls under it.
              <div className="mx-auto min-h-0 w-full min-w-0 max-w-[44rem] lg:max-w-none">
                {pane === 'lyrics'
                  ? <div className="-mx-1 h-full"><LyricsPane lyrics={state.lyrics} onSeek={controls.seek} /></div>
                  : <div className="-mx-2 h-full overflow-y-auto lg:mx-auto lg:max-w-xl"><QueueContent player={player} modes={false} /></div>}
              </div>
            )}
          </div>

          <div className="relative mx-auto w-full max-w-3xl shrink-0 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2 md:px-8">
            <div className="mb-4 flex items-center gap-3">
              {pane !== 'art' && <Cover artwork={artwork} size={96} className="size-12 lg:hidden" />}
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-2xl font-semibold tracking-tight">{item?.track.title ?? 'Nothing playing'}</h2>
                {item && (
                  <p className="truncate text-base text-muted-foreground">
                    {late
                      ? STILL_LOADING_LABEL
                      : item.track.artists[0]
                        ? <Link to={`/artist/${item.track.artists[0].id}`} onClick={() => onOpenChange(false)} className="hover:text-foreground hover:underline">{item.track.artistCredit}</Link>
                        : item.track.artistCredit}
                  </p>
                )}
              </div>
              {item && (
                <IconButton label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'} size="lg" onClick={onToggleLike} className={cn('max-md:size-11', liked && 'text-primary hover:text-primary')}>
                  <Heart fill={liked ? 'currentColor' : 'none'} />
                </IconButton>
              )}
            </div>
            <SeekBar stacked durationMs={item?.entry.durationMs ?? 0} onSeek={controls.seek} disabled={!item} />
            <div className="mt-1 flex flex-col items-center gap-3 md:flex-row md:justify-between">
              <div className="order-2 flex gap-8 md:order-1 md:w-40 md:gap-1">
                <IconButton label={pane === 'lyrics' ? 'Hide lyrics' : 'Show lyrics'} pressed={pane === 'lyrics'} onClick={() => toggle('lyrics')} className="max-md:size-11"><MessageSquareQuote /></IconButton>
                <IconButton label={pane === 'queue' ? 'Hide queue' : 'Show queue'} pressed={pane === 'queue'} onClick={() => toggle('queue')} className="max-md:size-11"><ListMusic /></IconButton>
              </div>
              <div className="order-1 md:order-2"><TransportButtons player={player} large disabled={!item} /></div>
              <VolumeControl volume={state.volume} onChange={controls.setVolume} fill className="order-3 hidden w-40 md:flex" />
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  )
}
