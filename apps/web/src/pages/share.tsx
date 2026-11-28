import { streamUrl } from '@squirmy/client-core'
import { SHARE_PREVIEW_MS, type PublicShare, type PublicShareTrack, type ShareKind } from '@squirmy/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link2Off, Pause, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { isNotFound } from '@/api/queries'
import { useApi } from '@/api/services'
import { LogoMark } from '@/components/layout/Logo'
import { Cover } from '@/components/music/Cover'
import { Badge, EmptyState, ExplicitBadge, Skeleton } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { FormError } from '@/components/ui/input'
import { LoadError } from '@/components/ui/query-state'
import { playableCodecs } from '@/lib/codecs'
import { formatDuration, formatTotalDuration, plural } from '@/lib/format'
import { cn } from '@/lib/utils'

const kindLabels: Record<ShareKind, string> = { album: 'Album', playlist: 'Playlist', track: 'Song' }

/**
 * A public share link (`/s/:token`): the shared album, playlist or song, for anyone with the
 * link and no account. It stands outside the signed-in app, with an `<audio>` element of its own
 * rather than the session player, and plays what the server allows: previews, whole songs or nothing.
 */
export function SharePage() {
  const { token = '' } = useParams()
  const api = useApi()
  const share = useQuery({ queryKey: ['public-share', token], queryFn: () => api.share.page(token), retry: (count, error) => !isNotFound(error) && count < 2 })
  // Outside the app shell nothing else names the tab.
  const title = share.data ? `${share.data.title}${share.data.artistCredit ? ` · ${share.data.artistCredit}` : ''}` : 'Shared music'
  useEffect(() => {
    document.title = title
  }, [title])
  return (
    <div className="min-h-dvh bg-background">
      <main className="mx-auto flex w-full max-w-3xl flex-col px-4 pb-16 pt-8 sm:px-6 sm:pt-12">
        {share.data ? <SharedItem token={token} share={share.data} />
          : share.error ? (isNotFound(share.error)
            ? <EmptyState icon={<Link2Off />} title="This link doesn’t work" description="It may have expired or been revoked. Ask whoever sent it for a new one." headingLevel={1} />
            : <LoadError title="This page didn’t load" error={share.error} retrying={share.isFetching} onRetry={() => void share.refetch()} />)
          : <ShareSkeleton />}
      </main>
    </div>
  )
}

function ShareSkeleton() {
  return (
    <div aria-busy className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-end">
        <Skeleton className="size-48 rounded-cover sm:size-56" />
        <div className="flex w-full flex-col gap-2"><Skeleton className="h-4 w-20" /><Skeleton className="h-8 w-64 max-w-full" /><Skeleton className="h-4 w-40" /></div>
      </div>
      {Array.from({ length: 6 }, (_, row) => <Skeleton key={row} className="h-11 w-full" />)}
    </div>
  )
}

type Playing = { trackId: string; paused: boolean; preview: boolean }

function SharedItem({ token, share }: { token: string; share: PublicShare }) {
  const api = useApi()
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState<Playing | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const canPlay = share.playback !== 'off'
  const available = share.tracks.filter(track => track.available)

  const start = async (track: PublicShareTrack) => {
    const element = audio.current
    if (!element) return
    setFailure(null)
    try {
      const song = await api.share.trackPlayback(token, track.id, { codecs: playableCodecs().join(',') })
      element.src = streamUrl('', song)
      setPlaying({ trackId: track.id, paused: false, preview: song.preview })
      await element.play()
    } catch (error) {
      setPlaying(null)
      // A browser that blocks playing on its own is not an error to show: the next tap plays.
      if (error instanceof DOMException && error.name === 'NotAllowedError') return
      setFailure(`Couldn’t play “${track.title}”. ${errorMessage(error)}`)
    }
  }
  const toggle = (track: PublicShareTrack) => {
    const element = audio.current
    if (playing?.trackId !== track.id || !element) return void start(track)
    if (element.paused) void element.play()
    else element.pause()
  }
  // At the end of a song the next one that plays starts, as on an album page.
  const next = () => {
    const index = available.findIndex(track => track.id === playing?.trackId)
    const following = index >= 0 ? available[index + 1] : undefined
    if (following) void start(following)
    else setPlaying(null)
  }
  useEffect(() => () => audio.current?.pause(), [])

  const meta = [kindLabels[share.kind], share.year ? String(share.year) : null, `${plural(share.tracks.length, 'song')}, ${formatTotalDuration(share.durationMs)}`].filter(Boolean).join(' · ')
  const first = available[0]
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col items-center gap-5 text-center sm:flex-row sm:items-end sm:text-left">
        <Cover artwork={share.artwork} size={600} alt="" className="size-48 shadow-lg sm:size-56" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{meta}</p>
          <h1 className="text-3xl font-bold tracking-tight wrap-anywhere sm:text-4xl">{share.title}</h1>
          {share.artistCredit && <p className="text-base text-muted-foreground">{share.artistCredit}</p>}
          {canPlay && first && (
            <div className="mt-3 flex items-center justify-center gap-3 sm:justify-start">
              <IconButton
                label={playing && !playing.paused ? 'Pause' : 'Play'}
                variant="primary"
                size="xl"
                shape="round"
                onClick={() => toggle(playing ? available.find(track => track.id === playing.trackId) ?? first : first)}
              >
                {playing && !playing.paused ? <Pause className="fill-current" /> : <Play className="fill-current" />}
              </IconButton>
              {share.playback === 'previews' && <Badge tone="neutral">{SHARE_PREVIEW_MS / 1000}-second previews</Badge>}
            </div>
          )}
        </div>
      </header>

      <FormError message={failure ?? undefined} />

      <ol aria-label={`${share.title} songs`} className="-mx-2 flex flex-col">
        {share.tracks.map((track, index) => {
          const current = playing?.trackId === track.id
          const playable = canPlay && track.available
          return (
            <li
              key={`${track.id}-${index}`}
              className={cn('group flex min-h-12 items-center gap-3 rounded-md px-2 py-1.5', playable && 'hover:bg-accent/60', !track.available && 'text-muted-foreground opacity-60')}
            >
              <div className="flex w-8 shrink-0 justify-center">
                {playable ? (
                  <IconButton label={current && !playing.paused ? `Pause ${track.title}` : `Play ${track.title}`} size="sm" variant="ghost" tooltip={false} onClick={() => toggle(track)}>
                    {current && !playing.paused ? <Pause className="fill-current" /> : <Play className="fill-current" />}
                  </IconButton>
                ) : <span className="tabular text-sm text-muted-foreground">{share.kind === 'album' ? track.position ?? '' : index + 1}</span>}
              </div>
              {share.kind !== 'album' && <Cover artwork={track.artwork} size={96} className="size-10" />}
              <div className="min-w-0 flex-1">
                <p className={cn('flex items-center gap-1.5 truncate text-sm font-medium', current && 'text-primary')}>
                  <span className="truncate">{track.title}</span>
                  {track.explicit && <ExplicitBadge />}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {track.available ? [share.kind === 'album' && track.artistCredit === share.artistCredit ? null : track.artistCredit, track.albumTitle].filter(Boolean).join(' · ') || ' ' : 'Not available'}
                </p>
              </div>
              <span className="shrink-0 text-xs tabular text-muted-foreground">{track.durationMs ? formatDuration(track.durationMs) : ''}</span>
            </li>
          )
        })}
      </ol>

      <footer className="flex flex-col items-center gap-2 border-t pt-6 text-center text-xs text-muted-foreground">
        <LogoMark size={24} />
        <p>Shared from {share.serverName}{share.playback === 'off' ? '. Listening isn’t available on this page.' : ''}</p>
      </footer>

      <audio
        ref={audio}
        preload="none"
        onPlay={() => setPlaying(state => state && { ...state, paused: false })}
        onPause={() => setPlaying(state => state && { ...state, paused: true })}
        onEnded={next}
        onError={() => {
          if (!playing) return
          setFailure('That song didn’t play. Try again in a moment.')
          setPlaying(null)
        }}
      />
    </div>
  )
}
