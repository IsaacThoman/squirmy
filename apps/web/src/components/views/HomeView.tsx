import type { AlbumSummary, HomeSection, PlaylistSummary } from '@squirmy/contracts'
import { Play } from 'lucide-react'
import { Link } from 'react-router'
import { Page } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, PlaylistCard } from '@/components/music/Cards'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { PageTitle, SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { Button } from '@/components/ui/button'
import { useArtUrl } from '@/lib/artwork'
import { useTrackActions } from '@/player/use-track-actions'

type HomeViewProps = {
  featured: AlbumSummary | null
  sections: HomeSection[]
  onPlayAlbum: (album: AlbumSummary) => void
  onPlayPlaylist: (playlist: PlaylistSummary) => void
}

export function HomeView({ featured, sections, onPlayAlbum, onPlayPlaylist }: HomeViewProps) {
  return (
    <Page className="flex flex-col gap-10">
      <PageTitle>Listen now</PageTitle>
      {featured && <Hero album={featured} onPlay={() => onPlayAlbum(featured)} />}
      {sections.map(section => {
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
