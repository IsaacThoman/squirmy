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
  return (
    <Page className="flex flex-col gap-10">
      <PageTitle>Listen now</PageTitle>
      {!sections && (
        <div role="status" aria-label="Loading" className="flex flex-col gap-10">
          <Skeleton className="h-44 rounded-[26px] md:h-64" />
          <RailSkeleton />
          <RailSkeleton />
        </div>
      )}
      {sections && empty && <EmptyLibrary canAddMusic={canAddMusic} scan={scan} />}
      {featured && <Hero album={featured} onPlay={() => onPlayAlbum(featured)} />}
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

function TrackSection({ title, tracks }: Pick<Extract<HomeSection, { kind: 'tracks' }>, 'title' | 'tracks'>) {
  const actions = useTrackActions(tracks)
  return (
    <section>
      <SectionHeader title={title} />
      <div className="-mx-2"><TrackList label={title} tracks={tracks} variant="compact" header={false} {...actions} /></div>
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

/** The featured album: its cover over a blur of itself, as on the iOS home screen. */
function Hero({ album, onPlay }: { album: AlbumSummary; onPlay: () => void }) {
  const artUrl = useArtUrl()
  return (
    <section aria-label="Featured" className="relative isolate overflow-hidden rounded-[26px] bg-[#322940] text-[#F5F2FF]" style={{ backgroundColor: album.artwork?.color ?? undefined }}>
      {album.artwork && <img aria-hidden src={artUrl(album.artwork, 300)} alt="" className="absolute inset-0 -z-10 size-full scale-125 object-cover opacity-70 blur-2xl saturate-150" />}
      <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-r from-[#100D16D0] via-[#100D1680] to-[#100D1620]" />
      <div className="flex items-center gap-5 p-5 md:gap-8 md:p-8">
        <Link to={`/album/${album.id}`} className="w-28 shrink-0 rounded-cover shadow-cover transition-transform duration-200 hover:scale-[1.02] sm:w-40 md:w-52" aria-label={`Open ${album.title}`}>
          <Cover artwork={album.artwork} size={600} />
        </Link>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#F0E6FA]/80">Featured from your library</p>
          <h2 className="mt-1.5 text-[clamp(1.75rem,4vw,3.5rem)] font-extrabold leading-none tracking-[-0.045em]">{album.title}</h2>
          <p className="mt-2 text-base font-medium text-[#F0E6FA]/85">{album.artistCredit}{album.year && ` · ${album.year}`}</p>
          <div className="mt-5 flex gap-2">
            <Button variant="primary" onClick={onPlay} className="bg-[#F5F2FF] text-[#19142B]"><Play fill="currentColor" />Play</Button>
            <Button asChild variant="ghost" className="bg-white/12 text-[#F5F2FF] backdrop-blur-md hover:bg-white/20 max-sm:hidden">
              <Link to={`/album/${album.id}`}>Open album</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
