import type { AlbumSummary, HomeSection, PlaylistSummary } from '@squirmy/contracts'
import { FolderPlus, Play } from 'lucide-react'
import { Link } from 'react-router'
import { Page, PageHeader } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, PlaylistCard } from '@/components/music/Cards'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { RailSkeleton } from '@/components/music/Skeletons'
import { Button } from '@/components/ui/button'
import { ProgressBar, Skeleton } from '@/components/ui/feedback'
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
    <>
      <PageHeader title="Listen now" />
      <Page className="flex flex-col gap-8">
        {!sections && (
          <div role="status" aria-label="Loading" className="flex flex-col gap-8">
            <Skeleton className="h-36 rounded-xl sm:h-48 md:h-56" />
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
    </>
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
    <section aria-label="Your library" className="flex flex-col items-center rounded-xl border bg-card px-6 py-12 text-center md:py-16">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl border bg-background text-muted-foreground shadow-xs">
        <FolderPlus className="size-5" />
      </div>
      <h2 className="text-balance text-lg font-semibold">
        {scanning ? 'Your music is on its way' : 'Nothing in your library yet'}
      </h2>
      <p className="mt-1 max-w-md text-pretty text-sm text-muted-foreground">
        {scanning
          ? `Scanning: ${plural(scan.processed, 'file')} of ${scan.total.toLocaleString()} read. Albums appear here as soon as they are ready.`
          : canAddMusic
            ? 'Point Squirmy at the folder that holds your music. Albums show up here as they are scanned, and play while they are identified.'
            : 'An admin of this server adds the music folders. Albums show up here as soon as one is scanned.'}
      </p>
      {canAddMusic && !scanning && (
        <Button asChild variant="primary" className="mt-5"><Link to="/admin/library"><FolderPlus />Add a music folder</Link></Button>
      )}
      {scanning && <ProgressBar value={Math.min(1, scan.processed / scan.total)} label="Scanning your music" className="mt-5 w-full max-w-xs" />}
    </section>
  )
}

/** The featured album: its cover over a blur of itself. The text is over artwork, so its colors do not follow the theme. */
function Hero({ album, onPlay }: { album: AlbumSummary; onPlay: () => void }) {
  const artUrl = useArtUrl()
  return (
    <section aria-label="Featured" className="relative isolate overflow-hidden rounded-xl bg-neutral-800 text-white" style={{ backgroundColor: album.artwork?.color ?? undefined }}>
      {album.artwork && <img aria-hidden src={artUrl(album.artwork, 300)} alt="" className="absolute inset-0 -z-10 size-full scale-125 object-cover opacity-70 blur-2xl saturate-150" />}
      <div aria-hidden className="absolute inset-0 -z-10 rounded-xl bg-linear-to-r from-black/75 via-black/50 to-black/20 ring-1 ring-inset ring-white/10" />
      <div className="flex items-center gap-4 p-4 sm:gap-6 sm:p-6">
        <Link to={`/album/${album.id}`} aria-label={`Open ${album.title}`} className="w-24 shrink-0 rounded-cover shadow-cover outline-none focus-visible:ring-2 focus-visible:ring-white sm:w-36 md:w-44">
          <Cover artwork={album.artwork} size={600} />
        </Link>
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-white/70">Featured from your library</p>
          <h2 className="mt-1.5 line-clamp-2 text-balance text-2xl font-semibold tracking-tight sm:text-3xl md:text-4xl">{album.title}</h2>
          <p className="mt-1.5 truncate text-sm text-white/75 sm:text-base">{album.artistCredit}{album.year && ` · ${album.year}`}</p>
          <div className="mt-4 flex gap-2 sm:mt-5">
            <Button variant="primary" onClick={onPlay} className="bg-white text-black hover:bg-white/90 focus-visible:ring-white"><Play fill="currentColor" />Play</Button>
            <Button asChild variant="ghost" className="bg-white/15 text-white backdrop-blur-md hover:bg-white/25 hover:text-white focus-visible:ring-white max-sm:hidden dark:hover:bg-white/25">
              <Link to={`/album/${album.id}`}>Open album</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
