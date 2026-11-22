import type { AlbumSummary, AlbumType, ArtistDetail } from '@squirmy/contracts'
import { ExternalLink, Radio } from 'lucide-react'
import { AlbumCard, ArtistCard, CardGrid, Monogram } from '@/components/music/Cards'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { Badge } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { albumTypeLabel, isPlayable } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { useLibrary } from '@/player/library-context'
import { useOnDemand } from '@/player/on-demand-context'
import { usePlayer } from '@/player/player-context'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'

const typeOrder: AlbumType[] = ['album', 'ep', 'single', 'compilation', 'live', 'soundtrack', 'other']
const groupTitles: Partial<Record<AlbumType, string>> = { album: 'Albums', ep: 'EPs', single: 'Singles', compilation: 'Compilations', soundtrack: 'Soundtracks' }

export function ArtistView({ artist, onPlayAlbum }: { artist: ArtistDetail; onPlayAlbum: (album: AlbumSummary) => void }) {
  const library = useLibrary()
  const { canRequest } = useOnDemand()
  const { controls } = usePlayer()
  const context = { type: 'artist' as const, id: artist.id, title: artist.name }
  const actions = useTrackActions(artist.topTracks, context)
  const wants = useAlbumWants()
  const owned = artist.albums.filter(album => album.availability === 'full' || album.availability === 'partial').length
  const playable = artist.topTracks.some(track => isPlayable(track, canRequest))
  const groups = typeOrder
    .map(type => ({ type, albums: artist.albums.filter(album => album.type === type) }))
    .filter(group => group.albums.length)

  return (
    <div className="mx-auto max-w-[94rem]">
      <CollectionHeader
        kind="Artist"
        title={artist.name}
        tint={artist.image?.color}
        art={artist.image ? <Cover artwork={artist.image} round size={600} alt={artist.name} /> : <Monogram name={artist.name} />}
        meta={[
          owned ? `${owned} of ${plural(artist.albums.length, 'release')} in your library` : plural(artist.albums.length, 'release'),
          !owned && artist.inLibrary && 'In your library',
        ]}
        actions={(
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
        )}
      />
      <div className="flex flex-col gap-9 px-(--gutter) pb-12">
        {artist.topTracks.length > 0 && (
          <section>
            <SectionHeader title="Top songs" />
            <TrackList label="Top songs" tracks={artist.topTracks} variant="compact" header={false} {...actions} />
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
          <section className="max-w-3xl rounded-2xl border border-stroke bg-sheet px-5 py-4">
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
