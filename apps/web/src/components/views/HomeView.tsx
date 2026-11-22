import type { AlbumSummary, HomeSection, PlaylistSummary } from '@squirmy/contracts'
import { ArrowRight, FolderPlus, Play, Upload } from 'lucide-react'
import type { CSSProperties } from 'react'
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
import { useTrackActions } from '@/player/use-track-actions'

export type ScanProgress = { processed: number; total: number }

type HomeViewProps = {
  featured: { album: AlbumSummary; label: string } | null
  /** Undefined while loading. */
  sections: HomeSection[] | undefined
  /** No music is in the library yet. */
  empty: boolean
  /** Admins are pointed at the library settings; members are told to ask one. */
  canAddMusic: boolean
  canUpload: boolean
  /** Files probed so far while a scan runs. */
  scan: ScanProgress | null
  onPlayAlbum: (album: AlbumSummary) => void
  onPlayPlaylist: (playlist: PlaylistSummary) => void
}

export function HomeView({ featured, sections, empty, canAddMusic, canUpload, scan, onPlayAlbum, onPlayPlaylist }: HomeViewProps) {
  return (
    <Page className="mx-auto flex max-w-[94rem] flex-col gap-8 md:gap-9">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <PageTitle>Listen now</PageTitle>
        {canUpload && (
          <Button asChild variant="outline" size="sm">
            <Link to="/imports"><Upload />Add music</Link>
          </Button>
        )}
      </header>
      {!sections && (
        <div role="status" aria-label="Loading" className="flex flex-col gap-10">
          <Skeleton className="h-48 rounded-2xl md:h-72" />
          <RailSkeleton />
          <RailSkeleton />
        </div>
      )}
      {sections && empty && <EmptyLibrary canAddMusic={canAddMusic} scan={scan} />}
      {featured && <Hero album={featured.album} label={featured.label} onPlay={() => onPlayAlbum(featured.album)} />}
      {sections?.map(section => {
        switch (section.kind) {
          case 'albums':
            return (
              <Rail key={section.id} title={section.title} href={section.id === 'recently-added' ? '/library/albums' : section.id === 'wantlist' ? '/wantlist' : undefined}>
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

function TrackSection({ title, tracks }: Pick<Extract<HomeSection, { kind: 'tracks' }>, 'title' | 'tracks'>) {
  const actions = useTrackActions(tracks)
  return (
    <section>
      <SectionHeader title={title} />
      <TrackList label={title} tracks={tracks} variant="compact" header={false} {...actions} />
    </section>
  )
}

/** A server with nothing scanned yet: what is happening, and where music comes from. */
function EmptyLibrary({ canAddMusic, scan }: { canAddMusic: boolean; scan: ScanProgress | null }) {
  const scanning = scan && scan.total > 0
  return (
    <section aria-label="Your library" className="rounded-2xl border border-stroke bg-sheet px-6 py-12 text-center md:px-10 md:py-16">
      <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-xl bg-selection text-accent">
        <FolderPlus className="size-6" />
      </div>
      <h2 className="text-balance text-[clamp(1.6rem,3vw,2.25rem)] font-extrabold tracking-[-0.04em]">
        {scanning ? 'Your music is on its way' : 'Nothing in your library yet'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-muted">
        {scanning
          ? `Scanning: ${plural(scan.processed, 'file')} of ${scan.total.toLocaleString()} read. Albums appear here as soon as they are ready.`
          : canAddMusic
            ? 'Add a folder containing your music. Albums are playable as soon as they are scanned.'
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

function Hero({ album, label, onPlay }: { album: AlbumSummary; label: string; onPlay: () => void }) {
  const url = `/album/${album.id}`
  return (
    <section
      aria-label="Featured"
      style={{ '--hero-color': album.artwork?.color ?? 'var(--accent)' } as CSSProperties}
      className="@container relative isolate overflow-hidden rounded-2xl border border-stroke bg-[linear-gradient(115deg,var(--sheet)_15%,color-mix(in_srgb,var(--hero-color)_25%,var(--surface)))]"
    >
      <div className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-5 p-5 @min-[35rem]:gap-x-8 @min-[35rem]:p-8 @min-[52rem]:px-12">
        <div className="min-w-0 self-end @min-[35rem]:self-auto">
          <p className="text-xs font-semibold uppercase tracking-[0.11em] text-muted">{label}</p>
          <h2 className="mt-1.5 text-balance break-words text-[clamp(1.5rem,5.6cqw,3.75rem)] font-extrabold leading-[1.04] tracking-[-0.05em]">
            <Link to={url} className="underline-offset-4 hover:underline">{album.title}</Link>
          </h2>
          <p className="mt-2 text-sm font-medium text-muted @min-[35rem]:text-base">{album.artistCredit}{album.year && ` · ${album.year}`}</p>
        </div>
        <div className="relative col-start-2 row-start-1 w-[clamp(4.5rem,26cqw,14rem)] self-center @min-[35rem]:row-span-2 @min-[52rem]:mr-8">
          <div aria-hidden className="absolute -inset-6 -z-10 rounded-full border border-foreground/10 @max-[35rem]:hidden" />
          <div aria-hidden className="absolute -inset-12 -z-10 rounded-full border border-foreground/10 @max-[35rem]:hidden" />
          <Cover artwork={album.artwork} size={600} alt={`${album.title} cover`} className="shadow-cover" />
        </div>
        <div className="col-span-2 flex flex-wrap items-center gap-2 self-start @min-[35rem]:col-span-1">
          <Button variant="primary" onClick={onPlay} aria-label={`Play album ${album.title}`}><Play fill="currentColor" />Play album</Button>
          <Button asChild variant="outline" className="bg-background/60">
            <Link to={url}>View album<ArrowRight /></Link>
          </Button>
        </div>
      </div>
    </section>
  )
}
