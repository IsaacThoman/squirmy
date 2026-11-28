import type { AlbumSummary, HomeItem, HomeSection, MixSummary, PlaylistSummary, RadioSummary } from '@squirmy/contracts'
import { FolderPlus, Search } from 'lucide-react'
import { Link } from 'react-router'
import { Page, PageHeader } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, LikedCard, MixCard, PlaylistCard, RadioCard } from '@/components/music/Cards'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { RailSkeleton } from '@/components/music/Skeletons'
import { Button } from '@/components/ui/button'
import { ProgressBar } from '@/components/ui/feedback'
import { plural } from '@/lib/format'
import { useMixMenu } from '@/player/use-mix-menu'
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
  onPlayMix: (mix: MixSummary) => void
  onPlayLiked: () => void
  onStartRadio: (radio: RadioSummary) => void
}

type ItemHandlers = Pick<HomeViewProps, 'onPlayAlbum' | 'onPlayPlaylist' | 'onPlayMix' | 'onPlayLiked' | 'onStartRadio'>

/**
 * Home sections, in the order the server sends them, each drawn by its kind alone. A kind this
 * app does not know (from a newer server) is left out.
 */
export function HomeView({ sections, empty, canAddMusic, canFindMusic = false, scan, ...handlers }: HomeViewProps) {
  const { onPlayAlbum, onPlayPlaylist } = handlers
  return (
    <>
      <PageHeader title="Listen now" />
      <Page className="flex flex-col gap-8">
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
              // Your top artists and Because you listened to are the whole list; no page holds more.
              return (
                <Rail key={section.id} title={section.title}>
                  {section.artists.map(artist => <RailItem key={artist.id}><ArtistCard artist={artist} /></RailItem>)}
                </Rail>
              )
            case 'items':
              if (!section.items.length) return null
              return (
                <Rail key={section.id} title={section.title}>
                  {section.items.map(item => <RailItem key={itemKey(item)}><ItemCard item={item} {...handlers} /></RailItem>)}
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
            default:
              return null
          }
        })}
      </Page>
    </>
  )
}

function itemKey(item: HomeItem): string {
  switch (item.kind) {
    case 'album': return `album:${item.album.id}`
    case 'artist': return `artist:${item.artist.id}`
    case 'playlist': return `playlist:${item.playlist.id}`
    case 'liked': return 'liked'
    case 'mix': return `mix:${item.mix.id}`
    case 'radio': return `radio:${item.radio.seed}:${item.radio.id}`
  }
}

/** One card of a rail of several kinds (Jump back in, Made for you): each kind's own card. */
function ItemCard({ item, onPlayAlbum, onPlayPlaylist, onPlayMix, onPlayLiked, onStartRadio }: { item: HomeItem } & ItemHandlers) {
  switch (item.kind) {
    case 'album': return <AlbumCard album={item.album} onPlay={() => onPlayAlbum(item.album)} />
    case 'artist': return <ArtistCard artist={item.artist} />
    case 'playlist': return <PlaylistCard playlist={item.playlist} onPlay={() => onPlayPlaylist(item.playlist)} />
    case 'liked': return <LikedCard onPlay={onPlayLiked} />
    case 'mix': return <HomeMixCard mix={item.mix} onPlay={() => onPlayMix(item.mix)} />
    case 'radio': return <RadioCard radio={item.radio} onPlay={() => onStartRadio(item.radio)} />
    default: return null
  }
}

function HomeMixCard({ mix, onPlay }: { mix: MixSummary; onPlay: () => void }) {
  return <MixCard mix={mix} onPlay={onPlay} menu={useMixMenu(mix)} />
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
    <section aria-label="Your library" className="flex flex-col items-center rounded-xl border bg-card px-6 py-12 text-center md:py-16">
      <div className="mb-4 flex size-11 items-center justify-center rounded-xl border bg-background text-muted-foreground shadow-xs">
        <FolderPlus className="size-5" />
      </div>
      <h2 className="text-balance text-lg font-semibold">
        {scanning ? 'Your music is on its way' : canFindMusic ? 'Start listening' : 'Nothing in your library yet'}
      </h2>
      <p className="mt-1 max-w-md text-pretty text-sm text-muted-foreground">
        {scanning
          ? `Scanning: ${plural(scan.processed, 'file')} of ${scan.total.toLocaleString()} read. Albums appear here as soon as they are ready.`
          : canFindMusic
            ? 'Search for any artist, album or song and play it. What you play and add to your library shows up here.'
            : canAddMusic
              ? 'Point Squirmy at the folder that holds your music. Albums show up here as they are scanned, and play while they are identified.'
              : 'An admin of this server adds the music folders. Albums show up here as soon as one is scanned.'}
      </p>
      {!scanning && (canFindMusic || canAddMusic) && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {canFindMusic && <Button asChild variant="primary"><Link to="/search"><Search />Find music</Link></Button>}
          {canAddMusic && <Button asChild variant={canFindMusic ? 'outline' : 'primary'}><Link to="/admin/library"><FolderPlus />Add a music folder</Link></Button>}
        </div>
      )}
      {scanning && <ProgressBar value={Math.min(1, scan.processed / scan.total)} label="Scanning your music" className="mt-5 w-full max-w-xs" />}
    </section>
  )
}
