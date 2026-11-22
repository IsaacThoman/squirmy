import { ChevronDown, Heart, ListMusic, MonitorSpeaker, Quote } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Link } from 'react-router'
import { Cover } from '@/components/music/Cover'
import { IconButton } from '@/components/ui/icon-button'
import { useArtUrl } from '@/lib/artwork'
import { cn } from '@/lib/utils'
import { playingElsewhere, type Player } from '@/player/player-context'
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

/** Full-screen player: big artwork over a blur of itself, with lyrics or the queue beside it. */
export function NowPlaying({ player, open, onOpenChange, pane, onPaneChange, liked, onToggleLike }: NowPlayingProps) {
  const { state, controls } = player
  const artUrl = useArtUrl()
  const item = state.current
  const artwork = item?.track.album?.artwork ?? null
  const elsewhere = playingElsewhere(state)
  const toggle = (next: NowPlayingPane) => onPaneChange(pane === next ? 'art' : next)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-40 flex animate-slide-in flex-col overflow-clip text-foreground focus:outline-none data-[state=closed]:animate-exit"
          style={{ backgroundColor: artwork?.color ?? 'var(--background)' }}
        >
          <div aria-hidden className="absolute inset-0">
            {artwork && (
              <img
                src={artUrl(artwork, 300)}
                alt=""
                className="absolute inset-[-10%] size-[120%] object-cover opacity-60 blur-[70px] saturate-150"
              />
            )}
            <div className="absolute inset-0" style={{ backgroundImage: 'linear-gradient(to bottom, var(--player-gradient))' }} />
          </div>

          {elsewhere && <PlayingElsewhere device={elsewhere} onPlayHere={() => controls.transfer(state.thisDeviceId)} className="relative" />}

          <div className="relative flex h-16 shrink-0 items-center justify-between px-4 pt-[env(safe-area-inset-top)] md:px-8">
            <DialogPrimitive.Close asChild>
              <IconButton label="Close Now Playing" tooltip={false} variant="solid" className="rounded-xl border border-stroke bg-overlay backdrop-blur-xl"><ChevronDown /></IconButton>
            </DialogPrimitive.Close>
            <div className="min-w-0 px-4 text-center">
              {state.context?.title && (
                <>
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Playing from {state.context.type}</p>
                  <p className="truncate text-sm font-semibold">{state.context.title}</p>
                </>
              )}
            </div>
            <DevicesPopover
              side="bottom"
              player={player}
              trigger={<IconButton label="Devices" variant="solid" className={cn('rounded-xl border border-stroke bg-overlay backdrop-blur-xl', elsewhere && 'text-accent')}><MonitorSpeaker /></IconButton>}
            />
          </div>

          <DialogPrimitive.Title className="sr-only">Now Playing</DialogPrimitive.Title>

          <div className={cn('relative grid min-h-0 flex-1 grid-cols-1 gap-10 px-6 py-4 md:px-12', pane !== 'art' && 'lg:grid-cols-2')}>
            <div className={cn('min-h-0 flex-col items-center justify-center gap-6', pane === 'art' ? 'flex' : 'hidden lg:flex')}>
              <div className="aspect-square h-auto max-h-full w-full max-w-[min(32rem,52vh)]">
                <Cover artwork={artwork} size={1200} className="size-full rounded-[18px] shadow-[0_30px_80px_-20px_rgb(0_0_0/0.55)]" />
              </div>
            </div>
            {pane !== 'art' && (
              <div className="min-h-0 overflow-clip rounded-[1.125rem] border border-stroke bg-overlay backdrop-blur-xl">
                {pane === 'lyrics'
                  ? <LyricsPane lyrics={state.lyrics} onSeek={controls.seek} />
                  : <div className="h-full overflow-y-auto p-2 pt-3 [scrollbar-width:thin]"><QueueContent player={player} /></div>}
              </div>
            )}
          </div>

          <div className="relative mx-auto w-full max-w-3xl shrink-0 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] md:px-8">
            <div className="md:rounded-[1.125rem] md:border md:border-stroke md:bg-overlay md:px-5 md:pb-4 md:pt-4 md:backdrop-blur-xl">
              <div className="mb-3 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-2xl font-bold tracking-[-0.03em] md:text-[28px]">{item?.track.title ?? 'Nothing playing'}</h2>
                  {item && (
                    <p className="truncate text-base font-medium text-muted">
                      {item.entry.state === 'preparing'
                        ? <span className="text-accent">Preparing…</span>
                        : item.track.artists[0]
                          ? <Link to={`/artist/${item.track.artists[0].id}`} onClick={() => onOpenChange(false)} className="hover:text-foreground hover:underline">{item.track.artistCredit}</Link>
                          : item.track.artistCredit}
                    </p>
                  )}
                </div>
                {item && (
                  <IconButton label={liked ? 'Remove from Liked Songs' : 'Save to Liked Songs'} size="lg" onClick={onToggleLike} className={cn(liked && 'text-accent hover:text-accent')}>
                    <Heart fill={liked ? 'currentColor' : 'none'} />
                  </IconButton>
                )}
              </div>
              <SeekBar durationMs={item?.entry.durationMs ?? 0} onSeek={controls.seek} disabled={!item} className="[&>span]:text-xs" />
              <div className="mt-4 flex flex-col items-center gap-3 md:flex-row md:justify-between">
                <div className="order-2 flex gap-6 md:order-1 md:w-40 md:gap-1">
                  <IconButton label={pane === 'lyrics' ? 'Hide lyrics' : 'Show lyrics'} pressed={pane === 'lyrics'} onClick={() => toggle('lyrics')} className="rounded-xl"><Quote /></IconButton>
                  <IconButton label={pane === 'queue' ? 'Hide queue' : 'Show queue'} pressed={pane === 'queue'} onClick={() => toggle('queue')} className="rounded-xl"><ListMusic /></IconButton>
                </div>
                <div className="order-1 md:order-2"><TransportButtons player={player} large disabled={!item} /></div>
                <VolumeControl volume={state.volume} onChange={controls.setVolume} className="order-3 hidden w-40 justify-end md:flex" />
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
