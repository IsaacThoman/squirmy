import type { AlbumSummary, HomeSection, PlaylistSummary } from '@squirmy/contracts'
import { FolderPlus, Play } from 'lucide-react'
import { Link } from 'react-router'
import { Page } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, PlaylistCard } from '@/components/music/Cards'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { PageTitle, SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { RailSkeleton } from '@/components/music/Skeletons'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/feedback'
import { plural } from '@/lib/format'
import { albumTypeLabel, isUnowned } from '@/lib/catalog'
import { useArtUrl } from '@/lib/artwork'
import { useTrackActions } from '@/player/use-track-actions'

export type ScanProgress = { processed: number; total: number }

type HomeViewProps = {
  featured: AlbumSummary | null
  /** Undefined while loading. */
  sections: HomeSection[] | undefined
  /** No music is in the library yet. */
  empty: boolean
  /** Admins are pointed at the library settings; members are told to ask one. */
  canAddMusic: boolean
  /** Files probed so far while a scan runs. */
  scan: ScanProgress | null
  onPlayAlbum: (album: AlbumSummary) => void
  onPlayPlaylist: (playlist: PlaylistSummary) => void
}

export function HomeView({ featured, sections, empty, canAddMusic, scan, onPlayAlbum, onPlayPlaylist }: HomeViewProps) {
  // The hero's side list continues the shelf the featured album came from.
  const shelves = sections?.filter(section => section.kind === 'albums' && section.albums.some(album => album.id === featured?.id)) ?? []
  const shelf = shelves.find(section => section.id === 'recently-played') ?? shelves[0]
  const companions = shelf?.kind === 'albums' ? shelf.albums.filter(album => album.id !== featured?.id).slice(0, 5) : []
  return (
    <Page className="flex flex-col gap-10 md:gap-12">
      <PageTitle>Listen now</PageTitle>
      {!sections && (
        <div role="status" aria-label="Loading" className="flex flex-col gap-10">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(17rem,1fr)]">
            <Skeleton className="h-56 rounded-[26px] md:h-80" />
            <Skeleton className="hidden rounded-[22px] lg:block" />
          </div>
          <RailSkeleton />
          <RailSkeleton />
        </div>
      )}
      {sections && empty && <EmptyLibrary canAddMusic={canAddMusic} scan={scan} />}
      {featured && (
        <div className={companions.length ? 'grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(17rem,1fr)]' : undefined}>
          <Hero album={featured} onPlay={() => onPlayAlbum(featured)} />
          {companions.length > 0 && shelf && <UpNextShelf title={shelf.title} albums={companions} onPlay={onPlayAlbum} />}
        </div>
      )}
      {sections?.map(section => {
        switch (section.kind) {
          case 'albums':
            return (
              <Rail key={section.id} title={section.title} href="/library/albums">
                {section.albums.map(album => <RailItem key={album.id}><AlbumCard album={album} onPlay={() => onPlayAlbum(album)} /></RailItem>)}
              </Rail>
            )
          case 'artists':
            return (
              <Rail key={section.id} title={section.title} href="/library/artists">
                {section.artists.map(artist => <RailItem key={artist.id}><ArtistCard artist={artist} /></RailItem>)}
              </Rail>
            )
          case 'playlists':
            return (
              <Rail key={section.id} title={section.title} href="/library/playlists">
                {section.playlists.map(playlist => <RailItem key={playlist.id}><PlaylistCard playlist={playlist} onPlay={() => onPlayPlaylist(playlist)} /></RailItem>)}
              </Rail>
            )
          case 'tracks':
            return <TrackSection key={section.id} title={section.title} tracks={section.tracks} />
        }
      })}
    </Page>
  )
}

/** The rest of the hero's shelf as a dense list, so the top of Home holds more than one album. */
function UpNextShelf({ title, albums, onPlay }: { title: string; albums: AlbumSummary[]; onPlay: (album: AlbumSummary) => void }) {
  return (
    <section aria-label={`More ${title.toLowerCase()}`} className="flex min-w-0 flex-col rounded-[22px] bg-surface p-3 max-lg:hidden">
      <h2 className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{title}</h2>
      <ul className="flex flex-1 flex-col justify-between gap-0.5">
        {albums.map(album => (
          <li key={album.id} className="group/row relative flex items-center gap-3 rounded-xl p-2 transition-colors hover:bg-overlay focus-within:bg-overlay focus-within:ring-1 focus-within:ring-accent">
            <div className="w-12 shrink-0"><Cover artwork={album.artwork} size={96} /></div>
            <div className="min-w-0 flex-1">
              <Link to={`/album/${album.id}`} title={album.title} className="block truncate text-sm font-semibold after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none">{album.title}</Link>
              <p className="truncate text-[13px] text-muted">{album.artistCredit}{album.year && ` · ${album.year}`}</p>
            </div>
            {!isUnowned(album) && (
              <button
                type="button"
                aria-label={`Play ${album.title}`}
                onClick={() => onPlay(album)}
                className="relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent opacity-0 transition duration-150 hover:scale-105 focus-visible:opacity-100 group-hover/row:opacity-100"
              >
                <Play className="size-4 translate-x-px" fill="currentColor" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

function TrackSection({ title, tracks }: Pick<Extract<HomeSection, { kind: 'tracks' }>, 'title' | 'tracks'>) {
  const actions = useTrackActions(tracks)
  return (
    <section aria-label={title} className="min-w-0 rounded-[22px] bg-surface/60 p-3 pt-2 shadow-[inset_0_0_0_1px_var(--stroke)] md:p-4 md:pt-3">
      <SectionHeader title={title} className="mb-1.5 px-1" />
      <TrackList label={title} tracks={tracks} variant="compact" header={false} {...actions} />
    </section>
  )
}

/** A server with nothing scanned yet: what is happening, and where music comes from. */
function EmptyLibrary({ canAddMusic, scan }: { canAddMusic: boolean; scan: ScanProgress | null }) {
  const scanning = scan && scan.total > 0
  return (
    <section aria-label="Your library" className="relative isolate overflow-hidden rounded-[26px] bg-surface px-6 py-12 text-center md:px-10 md:py-16">
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(120%_90%_at_50%_0%,var(--selection),transparent_70%)]" />
      <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-accent text-on-accent shadow-cover">
        <FolderPlus className="size-7" />
      </div>
      <h2 className="text-balance text-[clamp(1.6rem,3vw,2.25rem)] font-extrabold tracking-[-0.04em]">
        {scanning ? 'Your music is on its way' : 'Nothing in your library yet'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-muted">
        {scanning
          ? `Scanning: ${plural(scan.processed, 'file')} of ${scan.total.toLocaleString()} read. Albums appear here as soon as they are ready.`
          : canAddMusic
            ? 'Point Squirmy at the folder that holds your music. Albums show up here as they are scanned, and play while they are identified.'
            : 'An admin of this server adds the music folders. Albums show up here as soon as one is scanned.'}
      </p>
      {canAddMusic && !scanning && (
        <Button asChild variant="primary" className="mt-6"><Link to="/admin/library"><FolderPlus />Add a music folder</Link></Button>
      )}
      {scanning && (
        <div className="mx-auto mt-6 h-1.5 max-w-xs overflow-hidden rounded-full bg-stroke">
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.min(100, (scan.processed / scan.total) * 100)}%` }} />
        </div>
      )}
    </section>
  )
}

/** The featured album: its cover large over a blur of itself, as on the iOS home screen. */
function Hero({ album, onPlay }: { album: AlbumSummary; onPlay: () => void }) {
  const artUrl = useArtUrl()
  const details = [albumTypeLabel(album.type), album.year, album.trackCount ? plural(album.trackCount, 'track') : null].filter(Boolean).join(' · ')
  return (
    <section aria-label="Featured" className="relative isolate @container flex min-h-56 min-w-0 overflow-hidden rounded-[26px] bg-[#2a2140] text-[#F5F2FF] shadow-cover md:min-h-80" style={{ backgroundColor: album.artwork?.color ?? undefined }}>
      {album.artwork && <img aria-hidden src={artUrl(album.artwork, 300)} alt="" className="absolute inset-0 -z-10 size-full scale-125 object-cover opacity-75 blur-3xl saturate-150" />}
      <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-tr from-[#0d0a14e6] via-[#0d0a1499] to-[#0d0a1426]" />
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(90%_120%_at_100%_0%,color-mix(in_srgb,var(--accent)_28%,transparent),transparent_60%)] mix-blend-screen" />
      <div className="flex w-full items-center gap-[clamp(0.875rem,4cqw,2.25rem)] p-[clamp(1rem,4cqw,2rem)]">
        <Link to={`/album/${album.id}`} className="w-[clamp(5.5rem,39cqw,16rem)] shrink-0 rounded-cover shadow-[0_24px_48px_-12px_rgb(0_0_0/0.6)] transition-transform duration-200 hover:-rotate-1 hover:scale-[1.02]" aria-label={`Open ${album.title}`}>
          <Cover artwork={album.artwork} size={600} />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#F0E6FA]/75">Featured album</p>
          <h2 className="mt-2 line-clamp-2 text-balance text-[clamp(1.5rem,8cqw,3.75rem)] font-extrabold leading-[0.95] tracking-[-0.045em]">{album.title}</h2>
          <p className="mt-2.5 truncate text-base font-semibold text-[#F0E6FA]/90 md:text-lg">{album.artistCredit}</p>
          {details && <p className="mt-0.5 text-[13px] font-medium text-[#F0E6FA]/65">{details}</p>}
          <div className="mt-5 flex flex-wrap gap-2 @min-[32rem]:mt-7">
            <Button variant="primary" onClick={onPlay} className="bg-[#F5F2FF] text-[#19142B] hover:bg-white"><Play fill="currentColor" />Play</Button>
            <Button asChild variant="ghost" className="bg-white/12 text-[#F5F2FF] hidden backdrop-blur-md hover:bg-white/20 @min-[32rem]:inline-flex">
              <Link to={`/album/${album.id}`}>Open album</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
