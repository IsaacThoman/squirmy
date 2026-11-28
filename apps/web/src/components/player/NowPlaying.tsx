import { contextLabel } from '@squirmy/client-core'
import type { Artwork } from '@squirmy/contracts'
import { ChevronDown, ListMusic, MessageSquareQuote, MonitorSpeaker } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useRef, useState } from 'react'
import { ArtistLinks } from '@/components/music/ArtistLinks'
import { Cover } from '@/components/music/Cover'
import { SaveHeart } from '@/components/music/LibrarySave'
import { Dialog } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { useArtUrl } from '@/lib/artwork'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { playingElsewhere, usePlayer, type Player } from '@/player/player-context'
import { STILL_LOADING_LABEL, useStillLoading } from '@/player/use-still-loading'
import { DevicesPopover } from './Devices'
import { LyricsPane } from './Lyrics'
import { PlayerStatusLine } from './PlayerStatus'
import { QueueContent } from './Queue'
import { SleepTimerButton } from './SleepTimer'
import { SongMenuButton } from './SongMenu'
import { SeekBar, TransportButtons, VolumeControl } from './Transport'
import { useNowPlayingWheel } from './use-now-playing-wheel'
import './now-playing.css'

export type NowPlayingPane = 'art' | 'lyrics' | 'queue'

type NowPlayingProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  pane: NowPlayingPane
  onPaneChange: (pane: NowPlayingPane) => void
}

/** The theme's background over the blurred artwork: a tint at the top, solid under the controls. */
const wash = 'linear-gradient(to bottom, color-mix(in srgb, var(--background) 55%, transparent), color-mix(in srgb, var(--background) 80%, transparent) 40%, var(--background))'

/** Mount details on first use, then keep their scroll positions when switching panes. */
function NowPlayingStage({ player, pane, artwork, onClose }: { player: Player; pane: NowPlayingPane; artwork: Artwork | null; onClose: () => void }) {
  const [visited, setVisited] = useState(() => new Set([pane]))
  if (!visited.has(pane)) setVisited(new Set([...visited, pane]))
  return (
    <div data-pane={pane} className="now-playing-stage relative grid min-h-0 flex-1 px-6 py-4 md:px-8 lg:px-10 short-landscape:self-stretch short-landscape:py-2">
      <div className="now-playing-art relative flex min-h-0 min-w-0 items-center justify-center [container-type:size]">
        <Cover artwork={artwork} size={1200} className="size-[min(100cqw,100cqh,34rem)] rounded-xl shadow-[0_32px_80px_-24px_rgb(0_0_0/0.6)]" />
      </div>
      <div className="now-playing-details relative min-h-0 min-w-0">
        <div data-now-playing-scroll id="now-playing-lyrics" inert={pane !== 'lyrics'} aria-hidden={pane !== 'lyrics'} className="now-playing-pane now-playing-lyrics overflow-clip">
          {visited.has('lyrics') && <LyricsPane lyrics={player.state.lyrics} onSeek={player.controls.seek} />}
        </div>
        <div data-now-playing-scroll id="now-playing-queue" inert={pane !== 'queue'} aria-hidden={pane !== 'queue'} className="now-playing-pane now-playing-queue flex flex-col overflow-hidden">
          {visited.has('queue') && <QueueContent player={player} modes={false} shown={pane === 'queue'} onNavigate={onClose} className="h-full" />}
        </div>
      </div>
    </div>
  )
}

/** Full-screen player: big artwork over a blur of itself, with lyrics or the queue beside it. */
export function NowPlaying({ open, onOpenChange, pane, onPaneChange }: NowPlayingProps) {
  const onWheel = useNowPlayingWheel('down', () => onOpenChange(false))
  // Opened from the player rather than a dialog trigger, Radix has nothing to give focus back to on close.
  const opener = useRef<HTMLElement | null>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // The player's own keys (Space, arrows) still work here, unlike in other dialogs.
          data-player-keys=""
          onWheel={open ? onWheel : undefined}
          onOpenAutoFocus={() => {
            // Focus has not moved in yet: this is what opened it.
            opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
          }}
          onCloseAutoFocus={event => {
            const target = opener.current
            opener.current = null
            if (!target?.isConnected) return
            event.preventDefault()
            target.focus()
          }}
          className="now-playing-slide fixed inset-0 z-40 flex flex-col overflow-clip bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-foreground outline-none"
        >
          <NowPlayingContent pane={pane} onPaneChange={onPaneChange} onOpenChange={onOpenChange} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  )
}

/** Radix keeps this content through the exit animation, then drops its player subscriptions. */
function NowPlayingContent({ pane, onPaneChange, onOpenChange }: Omit<NowPlayingProps, 'open'>) {
  const player = usePlayer()
  const { state, controls } = player
  const library = useLibrary()
  const artUrl = useArtUrl()
  const item = state.current
  const artwork = item?.track.album?.artwork ?? null
  const elsewhere = playingElsewhere(state)
  const label = contextLabel(state.context)
  const late = useStillLoading(item?.entry, state.waiting)
  const toggle = (next: NowPlayingPane) => onPaneChange(pane === next ? 'art' : next)
  const onToggleLike = () => {
    if (!item) return
    const { id, title, liked } = item.track
    void library.setSaved({ type: 'track', id, title }, !liked)
  }

  return (
    <>
      <div aria-hidden className="absolute inset-0">
        {artwork && (
          // Held toward the theme's background, darker in dark mode, so the theme's text stays readable over any cover.
          <div className="absolute inset-0 opacity-50 saturate-200 dark:opacity-70 dark:brightness-60" style={{ backgroundColor: artwork.color ?? undefined }}>
            <img src={artUrl(artwork, 300)} alt="" className="absolute inset-[-10%] size-[120%] max-w-none object-cover blur-[70px]" />
          </div>
        )}
        <div className="absolute inset-0" style={{ backgroundImage: wash }} />
      </div>

      <div className="relative flex h-14 shrink-0 items-center justify-between gap-3 px-3 md:px-5">
        <DialogPrimitive.Close asChild>
          <IconButton label="Close Now Playing" tooltip={false} className="text-foreground max-md:size-11 pointer-coarse:size-11"><ChevronDown /></IconButton>
        </DialogPrimitive.Close>
        <div className="min-w-0 text-center">
          {label && (
            <>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label.heading}</p>
              <p className="truncate text-sm font-medium">{label.title}</p>
            </>
          )}
        </div>
        <DevicesPopover
          side="bottom"
          player={player}
          trigger={<IconButton label="Devices" className={cn('max-md:size-11 pointer-coarse:size-11', elsewhere || state.detached ? 'text-primary hover:text-primary' : 'text-foreground')}><MonitorSpeaker /></IconButton>}
        />
      </div>

      <DialogPrimitive.Title className="sr-only">Now Playing</DialogPrimitive.Title>

      {/*
        On a phone on its side the controls go beside the artwork, lyrics or queue, which keep the height.
        They come first in the document, drawn after: Tab reaches Play and Seek before the lines of a
        song or a long queue.
      */}
      <div className="relative flex min-h-0 flex-1 flex-col short-landscape:flex-row short-landscape:items-center">
        <div className="relative order-last mx-auto w-full max-w-3xl shrink-0 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2 md:px-8 short-landscape:w-[min(24rem,50%)] short-landscape:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mb-4 flex items-center gap-3">
            <div aria-hidden data-show={pane !== 'art'} className="now-playing-small-cover shrink-0 overflow-clip lg:hidden">
              <Cover artwork={artwork} size={96} className="size-12 max-w-none" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-2xl font-semibold tracking-tight">{item?.track.title ?? 'Nothing playing'}</h2>
              {item && (
                // A line of words, cut short; the song's menu goes to each artist too (`data-inline-links`).
                <p data-inline-links className="truncate text-base text-muted-foreground">
                  {late
                    ? STILL_LOADING_LABEL
                    : <ArtistLinks credit={item.track} onNavigate={() => onOpenChange(false)} />}
                </p>
              )}
              <PlayerStatusLine status={state.status} className="mt-1 text-sm" />
            </div>
            {/* Named after the song, as in the player bar: never the page's own heart. */}
            {item && <SaveHeart id={item.track.id} liked={item.track.liked} onToggle={onToggleLike} title={item.track.title} size="lg" className="max-md:size-11 pointer-coarse:size-11" />}
            {item && <SongMenuButton track={item.track} onNavigate={() => onOpenChange(false)} size="lg" className="-ml-2 text-foreground max-md:size-11 pointer-coarse:size-11" />}
          </div>
          <SeekBar stacked durationMs={item?.entry.durationMs ?? 0} onSeek={controls.seek} disabled={!item} />
          <div className="mt-1 flex flex-col items-center gap-3 md:flex-row md:justify-between short-landscape:flex-col!">
            <div className="order-2 flex gap-8 md:order-1 md:w-40 md:gap-1 short-landscape:order-2! short-landscape:w-auto! short-landscape:gap-8!">
              <IconButton label={pane === 'lyrics' ? 'Hide lyrics' : 'Show lyrics'} aria-controls="now-playing-lyrics" pressed={pane === 'lyrics'} onClick={() => toggle('lyrics')} className="max-md:size-11 pointer-coarse:size-11"><MessageSquareQuote /></IconButton>
              <IconButton label={pane === 'queue' ? 'Hide queue' : 'Show queue'} aria-controls="now-playing-queue" pressed={pane === 'queue'} onClick={() => toggle('queue')} className="max-md:size-11 pointer-coarse:size-11"><ListMusic /></IconButton>
              <SleepTimerButton player={player} className="max-md:size-11 pointer-coarse:size-11" />
            </div>
            <div className="order-1 md:order-2 short-landscape:order-1!"><TransportButtons player={player} large disabled={!item} /></div>
            <VolumeControl volume={state.volume} deviceId={state.activeDeviceId ?? state.thisDeviceId} onChange={controls.setVolume} fill className="order-3 hidden w-40 md:flex short-landscape:hidden!" />
          </div>
        </div>
        <NowPlayingStage player={player} pane={pane} artwork={artwork} onClose={() => onOpenChange(false)} />

      </div>
    </>
  )
}
