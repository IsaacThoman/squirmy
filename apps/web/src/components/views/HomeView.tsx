import type { AlbumSummary, HomeSection, PlaylistSummary } from '@squirmy/contracts'
import { FolderPlus, Search } from 'lucide-react'
import { Link } from 'react-router'
import { Page, PageTitle } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, PlaylistCard } from '@/components/music/Cards'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { RailSkeleton } from '@/components/music/Skeletons'
import { Button } from '@/components/ui/button'
import { ProgressBar } from '@/components/ui/feedback'
import { useTrackActions } from '@/player/use-track-actions'

export type ScanProgress = { processed: number; total: number }

type HomeViewProps = {
  /** Undefined while loading. */
  sections: HomeSection[] | undefined
  /** Nothing played, added or liked yet: no section has anything in it. */
  empty: boolean
  /** Admins are pointed at the library settings; members are told to ask one. */
  canAddMusic: boolean
  /** The server fetches music for this user, so a search is where to start. */
  canFindMusic?: boolean
  /** Files probed so far while a scan runs. */
  scan: ScanProgress | null
  onPlayAlbum: (album: AlbumSummary) => void
  onPlayPlaylist: (playlist: PlaylistSummary) => void
}

/** Home sections, in the order the server sends them. */
export function HomeView({ sections, empty, canAddMusic, canFindMusic = false, scan, onPlayAlbum, onPlayPlaylist }: HomeViewProps) {
  return (
    <Page className="flex flex-col gap-8 max-md:pt-14">
      <PageTitle>Listen now</PageTitle>
      {!sections && (
        <div role="status" aria-label="Loading" className="flex flex-col gap-8">
          <RailSkeleton />
          <RailSkeleton />
        </div>
      )}
      {sections && empty && <EmptyLibrary canAddMusic={canAddMusic} canFindMusic={canFindMusic} scan={scan} />}
      {sections?.map(section => {
        switch (section.kind) {
          case 'albums':
            if (!section.albums.length) return null
            return (
              // What was added is the server's music, all of it on its page; played albums have no page of their own.
              <Rail key={section.id} title={section.title} href={section.id === 'recently-added' ? '/collection?filter=albums' : undefined}>
                {section.albums.map(album => <RailItem key={album.id}><AlbumCard album={album} onPlay={() => onPlayAlbum(album)} /></RailItem>)}
              </Rail>
            )
          case 'artists':
            return (
              <Rail key={section.id} title={section.title} href="/library?filter=artists">
                {section.artists.map(artist => <RailItem key={artist.id}><ArtistCard artist={artist} /></RailItem>)}
              </Rail>
            )
          case 'playlists':
            return (
              <Rail key={section.id} title={section.title} href="/library?filter=playlists">
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

/**
 * Nothing to show yet: what is happening, and where music comes from. Where the server fetches
 * music for the user, that is a search away; otherwise it comes from a music folder.
 */
function EmptyLibrary({ canAddMusic, canFindMusic, scan }: { canAddMusic: boolean; canFindMusic: boolean; scan: ScanProgress | null }) {
  const scanning = scan && scan.total > 0
  return (
    <section aria-labelledby="empty-home-title" className="flex flex-col items-start rounded-xl border bg-card p-6">
      <h2 id="empty-home-title" className="text-lg font-semibold">
        {scanning ? 'Scanning music' : canFindMusic ? 'Start listening' : 'No music on this server yet'}
      </h2>
      <p className="mt-2 max-w-md text-pretty text-sm text-muted-foreground">
        {scanning
          ? `${scan.processed.toLocaleString()} of ${scan.total.toLocaleString()} files read. Albums appear as they’re scanned.`
          : canFindMusic
            ? 'Search for a song, album or artist. Recent plays and music you save show up here.'
            : canAddMusic
              ? 'Add a music folder to start scanning. You can play albums while Squirmy identifies them.'
              : 'Albums appear here after a server admin adds and scans a music folder.'}
      </p>
      {!scanning && (canFindMusic || canAddMusic) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {canFindMusic && <Button asChild variant="primary"><Link to="/search"><Search />Find music</Link></Button>}
          {canAddMusic && <Button asChild variant={canFindMusic ? 'outline' : 'primary'}><Link to="/admin/library"><FolderPlus />Add a music folder</Link></Button>}
        </div>
      )}
      {scanning && <ProgressBar value={Math.min(1, scan.processed / scan.total)} label="Scanning your music" className="mt-4 w-full max-w-xs" />}
    </section>
  )
}
