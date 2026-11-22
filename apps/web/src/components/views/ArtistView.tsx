import type { AlbumSummary, AlbumType, ArtistDetail, ArtistSummary } from '@squirmy/contracts'
import { ExternalLink, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { AlbumCard, ArtistCard, CardGrid, Monogram } from '@/components/music/Cards'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { Badge } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { albumPresentation, canFetch, isPlayable } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls } from '@/player/player-context'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'

const typeOrder: AlbumType[] = ['album', 'ep', 'single', 'compilation', 'live', 'soundtrack', 'other']
const groupTitles: Record<AlbumType, string> = {
  album: 'Albums', ep: 'EPs', single: 'Singles', compilation: 'Compilations', live: 'Live albums', soundtrack: 'Soundtracks', other: 'Other releases',
}

export function ArtistView({ artist, onPlayAlbum }: { artist: ArtistDetail; onPlayAlbum: (album: AlbumSummary) => void }) {
  const library = useLibrary()
  const viewer = useViewer()
  const controls = usePlayerControls()
  const context = { type: 'artist' as const, id: artist.id, title: artist.name }
  const actions = useTrackActions(artist.topTracks, context)
  const wants = useAlbumWants()
  // A requester plays everything here, so only someone who may not fetch music is told how much plays.
  const playing = artist.albums.filter(album => albumPresentation(album, viewer) === 'normal').length
  const playable = artist.topTracks.some(track => isPlayable(track, viewer))
  const groups = typeOrder
    .map(type => ({ type, albums: artist.albums.filter(album => album.type === type) }))
    .filter(group => group.albums.length)
  const hasTop = artist.topTracks.length > 0
  const hasAbout = Boolean(artist.bio) || artist.genres.length > 0

  return (
    <div>
      <ArtistHeader
        artist={artist}
        line={canFetch(viewer) || playing === artist.albums.length ? plural(artist.albums.length, 'release') : `${playing} of ${plural(artist.albums.length, 'release')} available`}
        actions={(
          <PlayActions
            title={artist.name}
            onPlay={playable ? () => controls.playTracks(artist.topTracks, 0, context) : undefined}
            onShuffle={playable ? () => controls.playTracks(artist.topTracks, 0, context, { shuffle: true }) : undefined}
            liked={artist.liked}
            onLike={() => library.setLiked('artist', artist.id, !artist.liked)}
          >
            {/* The server says whether a radio starts for this viewer; an older one does not, and then the library decides. */}
            {(artist.radio ?? (artist.inLibrary || canFetch(viewer))) && (
              <IconButton label={`Start ${artist.name} radio`} size="lg" onClick={() => controls.startRadio({ type: 'artist', id: artist.id })}><Radio /></IconButton>
            )}
          </PlayActions>
        )}
      />

      <div className="@container flex flex-col gap-10 px-(--gutter) pb-10">
        {(hasTop || hasAbout) && (
          // The songs and the biography sit side by side once the page is wide enough for both.
          <div className={cn('grid gap-10', hasTop && hasAbout && '@4xl:grid-cols-[minmax(0,1fr)_20rem]')}>
            {hasTop && (
              <section>
                <SectionHeader title="Top songs" />
                <div className="-mx-2"><TrackList label="Top songs" tracks={artist.topTracks} variant="compact" header={false} {...actions} /></div>
              </section>
            )}
            {hasAbout && (
              <section className="max-w-2xl">
                <SectionHeader title="About" />
                {artist.bio && <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{artist.bio}</p>}
                {artist.bioUrl && (
                  <a href={artist.bioUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                    Read more<ExternalLink className="size-3.5" />
                  </a>
                )}
                {artist.genres.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-1.5">{artist.genres.map(genre => <Badge key={genre} tone="outline">{genre}</Badge>)}</div>
                )}
              </section>
            )}
          </div>
        )}

        {groups.map(group => (
          <section key={group.type}>
            <SectionHeader title={groupTitles[group.type]} />
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

        {artist.similar.length > 0 && (
          <Rail title="Similar artists">
            {artist.similar.map(similar => <RailItem key={similar.id}><ArtistCard artist={similar} /></RailItem>)}
          </Rail>
        )}
      </div>
    </div>
  )
}

/** The top of an artist page. `line` says how much of them is in the library; a preview drawn from a summary leaves it out. */
export function ArtistHeader({ artist, line, actions }: { artist: ArtistSummary; line?: string; actions?: ReactNode }) {
  return (
    <CollectionHeader
      kind={artist.inLibrary ? 'Artist · In your library' : 'Artist'}
      title={artist.name}
      tint={artist.image?.color}
      art={artist.image ? <Cover artwork={artist.image} round size={600} alt={artist.name} /> : <Monogram name={artist.name} className="text-6xl" />}
      meta={[line]}
      actions={actions}
    />
  )
}
