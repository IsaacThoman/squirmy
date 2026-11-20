import type { AlbumSummary, AlbumType, ArtistDetail } from '@squirmy/contracts'
import { ExternalLink, Radio } from 'lucide-react'
import { AlbumCard, ArtistCard, CardGrid, Monogram } from '@/components/music/Cards'
import { PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { Badge } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { useArtUrl } from '@/lib/artwork'
import { albumTypeLabel } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { useLibrary } from '@/player/library-context'
import { usePlayer } from '@/player/player-context'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'

const typeOrder: AlbumType[] = ['album', 'ep', 'single', 'compilation', 'live', 'soundtrack', 'other']
const groupTitles: Partial<Record<AlbumType, string>> = { album: 'Albums', ep: 'EPs', single: 'Singles', compilation: 'Compilations', soundtrack: 'Soundtracks' }

export function ArtistView({ artist, onPlayAlbum }: { artist: ArtistDetail; onPlayAlbum: (album: AlbumSummary) => void }) {
  const artUrl = useArtUrl()
  const library = useLibrary()
  const { controls } = usePlayer()
  const context = { type: 'artist' as const, id: artist.id, title: artist.name }
  const actions = useTrackActions(artist.topTracks, context)
  const wants = useAlbumWants()
  const owned = artist.albums.filter(album => album.availability === 'full' || album.availability === 'partial').length
  const playable = artist.topTracks.some(track => track.availability !== 'none')
  const groups = typeOrder
    .map(type => ({ type, albums: artist.albums.filter(album => album.type === type) }))
    .filter(group => group.albums.length)

  return (
    <div>
      <header className="relative isolate overflow-hidden px-(--gutter) pb-8 pt-28 md:pt-36" style={{ backgroundColor: artist.image?.color ?? 'var(--surface)' }}>
        {artist.image && <img aria-hidden alt="" src={artUrl(artist.image, 600)} className="absolute inset-0 -z-10 size-full scale-110 object-cover opacity-60 blur-xl saturate-125" />}
        <div aria-hidden className="absolute inset-0 -z-10 bg-linear-to-b from-[#100D1630] via-[#100D1660] to-[#100D16D8]" />
        <div className="flex flex-col items-center gap-5 text-center text-[#F5F2FF] md:flex-row md:items-end md:gap-7 md:text-left">
          <div className="w-36 shrink-0 shadow-cover md:w-44">
            {artist.image ? <Cover artwork={artist.image} round size={600} alt={artist.name} /> : <Monogram name={artist.name} className="bg-white/15 text-white" />}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#F0E6FA]/80">{artist.inLibrary ? 'Artist · In your library' : 'Artist'}</p>
            <h1 className="mt-1 text-balance text-[clamp(2.5rem,7vw,5.5rem)] font-extrabold leading-[0.95] tracking-[-0.05em]">{artist.name}</h1>
            <p className="mt-3 text-sm font-medium text-[#F0E6FA]/85">
              {owned ? `${plural(owned, 'release')} of ${artist.albums.length} in your library` : `${plural(artist.albums.length, 'release')}, none in your library`}
            </p>
          </div>
        </div>
      </header>

      <div className="flex flex-col gap-11 px-(--gutter) pb-12 pt-6">
        <div className="flex items-center justify-center gap-2 md:justify-start">
          <PlayActions
            title={artist.name}
            onPlay={playable ? () => controls.playTracks(artist.topTracks, 0, context) : undefined}
            onShuffle={playable ? () => controls.playTracks(artist.topTracks, 0, context, { shuffle: true }) : undefined}
            liked={artist.liked}
            onLike={() => library.setLiked('artist', artist.id, !artist.liked)}
          >
            {artist.inLibrary && (
              <IconButton label={`Start ${artist.name} radio`} size="lg" onClick={() => controls.startRadio({ type: 'artist', id: artist.id })}><Radio /></IconButton>
            )}
          </PlayActions>
        </div>

        {artist.topTracks.length > 0 && (
          <section>
            <SectionHeader title="Top songs" />
            <div className="-mx-2"><TrackList label="Top songs" tracks={artist.topTracks} variant="compact" header={false} {...actions} /></div>
          </section>
        )}

        {groups.map(group => (
          <section key={group.type}>
            <SectionHeader title={groupTitles[group.type] ?? albumTypeLabel(group.type)} />
            <CardGrid>
              {group.albums.map(album => (
                <AlbumCard
                  key={album.id}
                  album={album}
                  subtitle="year"
                  onPlay={() => onPlayAlbum(album)}
                  {...wants(album)}
                />
              ))}
            </CardGrid>
          </section>
        ))}

        {(artist.bio || artist.genres.length > 0) && (
          <section className="max-w-3xl">
            <SectionHeader title="About" />
            {artist.bio && <p className="text-[15px] leading-relaxed text-muted">{artist.bio}</p>}
            {artist.bioUrl && (
              <a href={artist.bioUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-accent hover:underline">
                Read more<ExternalLink className="size-3.5" />
              </a>
            )}
            {artist.genres.length > 0 && (
              <div className="mt-4 flex flex-wrap gap-2">{artist.genres.map(genre => <Badge key={genre} tone="outline" className="h-6 px-2.5 text-[12px] normal-case tracking-normal">{genre}</Badge>)}</div>
            )}
          </section>
        )}

        {artist.similar.length > 0 && (
          <Rail title="Similar artists">
            {artist.similar.map(similar => <RailItem key={similar.id}><ArtistCard artist={similar} /></RailItem>)}
          </Rail>
        )}
      </div>
    </div>
  )
}
