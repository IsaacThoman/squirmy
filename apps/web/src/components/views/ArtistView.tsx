import { ARTIST_SECTION_KEYS, type AlbumSummary, type AlbumType, type ArtistDetail, type ArtistSection, type ArtistSectionKey, type ArtistSummary } from '@squirmy/contracts'
import { ChevronLeft, Disc3, ExternalLink, Radio } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Page, PageHeader } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, Monogram } from '@/components/music/Cards'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { GridSkeleton } from '@/components/music/Skeletons'
import { TrackList } from '@/components/music/TrackList'
import { VirtualGrid } from '@/components/music/VirtualGrid'
import { Badge, EmptyState, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { albumPresentation, artistReleasesPath, artistSectionTitle, canFetch, isArtistSectionKey, isPlayable } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls } from '@/player/player-context'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'

/**
 * The release sections of an artist page. A server that predates `sections` sends every release
 * in `albums`, so they are grouped by type here, and none offers "See all": it has no route to page them.
 */
function sectionsOf(artist: ArtistDetail): ArtistSection[] {
  if (artist.sections) return artist.sections
  const types = ARTIST_SECTION_KEYS.filter((key): key is AlbumType => key !== 'mixtape' && key !== 'appears_on')
  return [
    ...types.map(type => ({ key: type as string, items: artist.albums.filter(album => album.type === type) })),
    // Releases of other artists that credit this one come last, under their own heading.
    { key: 'appears_on', items: artist.appearsOn ?? [] },
  ].filter(section => section.items.length).map(section => ({ ...section, title: '', total: section.items.length }))
}

/**
 * How many of the artist's releases there are, and how many play for a viewer who may not fetch.
 * A server that predates the counts sends every release in `albums`, so they are counted there.
 */
function releaseCounts(artist: ArtistDetail, viewer: ReturnType<typeof useViewer>) {
  if (artist.releaseCount !== undefined && artist.ownedReleaseCount !== undefined) return { total: artist.releaseCount, playing: artist.ownedReleaseCount }
  return { total: artist.albums.length, playing: artist.albums.filter(album => albumPresentation(album, viewer) === 'normal').length }
}

export function ArtistView({ artist, onPlayAlbum }: { artist: ArtistDetail; onPlayAlbum: (album: AlbumSummary) => void }) {
  const library = useLibrary()
  const viewer = useViewer()
  const controls = usePlayerControls()
  const context = { type: 'artist' as const, id: artist.id, title: artist.name }
  const actions = useTrackActions(artist.topTracks, context)
  const wants = useAlbumWants()
  // A requester plays everything here, so only someone who may not fetch music is told how much plays.
  const { total, playing } = releaseCounts(artist, viewer)
  const playable = artist.topTracks.some(track => isPlayable(track, viewer))
  const sections = sectionsOf(artist)
  const hasTop = artist.topTracks.length > 0
  const hasAbout = Boolean(artist.bio) || artist.genres.length > 0

  return (
    <div>
      <ArtistHeader
        artist={artist}
        line={canFetch(viewer) || playing === total ? plural(total, 'release') : `${playing} of ${plural(total, 'release')} available`}
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

        {/* The rest of a large discography comes in after the page opens; the page refreshes as it does. */}
        {artist.detailPending && (
          <p role="status" className="-mb-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner label={null} className="size-4" />Loading discography…
          </p>
        )}

        {/* One row per section, newest first; "See all" pages the rest of a section on its own page. */}
        {sections.map(section => (
          <Rail
            key={section.key}
            title={artistSectionTitle(section.key, section.title)}
            href={section.total > section.items.length && isArtistSectionKey(section.key) ? artistReleasesPath(artist.id, section.key) : undefined}
          >
            {section.items.map(album => (
              <RailItem key={album.id}>
                <AlbumCard
                  album={album}
                  // A record of someone else's says whose it is.
                  subtitle={section.key === 'appears_on' ? 'artist-year' : 'year'}
                  onPlay={() => onPlayAlbum(album)}
                  {...wants(album)}
                />
              </RailItem>
            ))}
          </Rail>
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

/**
 * The top of an artist page. `line` says how much of them is in the library; a preview drawn from a
 * summary leaves it out. The disambiguation leads the line, so two artists of one name can be told apart.
 */
export function ArtistHeader({ artist, line, actions }: { artist: ArtistSummary & { disambiguation?: string | null }; line?: string; actions?: ReactNode }) {
  return (
    <CollectionHeader
      kind={artist.inLibrary ? 'Artist · In your library' : 'Artist'}
      title={artist.name}
      tint={artist.image?.color}
      art={artist.image ? <Cover artwork={artist.image} round size={600} alt={artist.name} /> : <Monogram name={artist.name} className="text-6xl" />}
      meta={[artist.disambiguation, line]}
      actions={actions}
    />
  )
}

type ArtistReleasesViewProps = {
  /** Undefined until the artist has loaded; the page then says only which section it is. */
  artist: ArtistSummary | undefined
  artistId: string
  section: ArtistSectionKey
  /** How many releases the section has, when the artist page said. */
  total?: number
  /** Undefined while the first page loads. */
  albums: AlbumSummary[] | undefined
  onEndReached: () => void
  onPlayAlbum: (album: AlbumSummary) => void
}

/** Every release of one section of an artist page, a page at a time as it scrolls. */
export function ArtistReleasesView({ artist, artistId, section, total, albums, onEndReached, onPlayAlbum }: ArtistReleasesViewProps) {
  const wants = useAlbumWants()
  const title = artistSectionTitle(section)
  return (
    <>
      <PageHeader title={artist ? `${artist.name} · ${title}` : title}>
        {total !== undefined && <span className="shrink-0 text-xs tabular text-muted-foreground">{plural(total, 'release')}</span>}
      </PageHeader>
      <Page className="flex flex-col gap-4">
        <Link
          to={`/artist/${artistId}`}
          className="-ml-1 inline-flex items-center gap-1 self-start rounded-md pr-1.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" />{artist?.name ?? 'Artist'}
        </Link>
        {!albums
          ? <GridSkeleton />
          : albums.length
            ? (
              <VirtualGrid
                label={title}
                items={albums}
                getKey={album => album.id}
                onEndReached={onEndReached}
                renderItem={album => (
                  <AlbumCard album={album} subtitle={section === 'appears_on' ? 'artist-year' : 'year'} onPlay={() => onPlayAlbum(album)} {...wants(album)} />
                )}
              />
            )
            : <EmptyState icon={<Disc3 />} title="Nothing here yet" />}
      </Page>
    </>
  )
}
