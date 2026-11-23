import { ARTIST_SECTION_KEYS, type AlbumSummary, type AlbumType, type ArtistDetail, type ArtistSection, type ArtistSectionKey, type ArtistSummary } from '@squirmy/contracts'
import { ChevronLeft, Disc3, ExternalLink, Radio } from 'lucide-react'
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
import { Button } from '@/components/ui/button'
import { Badge, EmptyState, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { albumPresentation, artistReleasesPath, artistSectionTitle, canFetch, isArtistSectionKey, isPlayable } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useLibrary } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls, useRadioStarting } from '@/player/player-context'
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
  const radioStarting = useRadioStarting({ type: 'artist', id: artist.id })
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
            id={artist.id}
            title={artist.name}
            onPlay={playable ? () => controls.playTracks(artist.topTracks, 0, context, { collection: true }) : undefined}
            onShuffle={playable ? () => controls.playTracks(artist.topTracks, 0, context, { shuffle: true, collection: true }) : undefined}
            liked={artist.liked}
            onLike={() => library.setSaved({ type: 'artist', id: artist.id, title: artist.name }, !artist.liked)}
          >
            {/* The server says whether a radio starts for this viewer; an older one does not, and then the library decides. */}
            {(artist.radio ?? (artist.inLibrary || canFetch(viewer))) && (
              <IconButton label={`Start ${artist.name} radio`} size="lg" aria-busy={radioStarting || undefined} onClick={() => controls.startRadio({ type: 'artist', id: artist.id })}>{radioStarting ? <Spinner label={null} className="text-current" /> : <Radio />}</IconButton>
            )}
          </PlayActions>
        )}
      />

      {/* As in the iOS app: the songs, then the releases, and what is written about the artist last. */}
      <div className="@container flex flex-col gap-10 px-(--gutter) pb-10">
        {hasTop && (
          <section>
            <SectionHeader title="Top songs" />
            <div className="-mx-2"><TrackList label="Top songs" tracks={artist.topTracks} variant="compact" header={false} {...actions} /></div>
          </section>
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

        {hasAbout && <ArtistAbout artist={artist} />}
      </div>
    </div>
  )
}

/**
 * The biography, three lines of it until More shows the rest (as the iOS app does), its source and
 * the artist's genres.
 */
function ArtistAbout({ artist }: { artist: ArtistDetail }) {
  const bio = useRef<HTMLParagraphElement>(null)
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  // Whether three lines cut the biography short: only then is there more to show.
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const element = bio.current
    if (!element || expanded) return
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [artist.bio, expanded])
  return (
    <section className="max-w-2xl">
      <SectionHeader title="About" />
      {artist.bio && <p id={id} ref={bio} className={cn('text-pretty text-sm leading-relaxed text-muted-foreground', !expanded && 'line-clamp-3')}>{artist.bio}</p>}
      {((artist.bio && (cut || expanded)) || artist.bioUrl) && (
        <div className="mt-2 flex items-center gap-4">
          {artist.bio && (cut || expanded) && (
            <Button variant="link" size="sm" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>{expanded ? 'Less' : 'More'}</Button>
          )}
          {artist.bioUrl && (
            <a href={artist.bioUrl} target="_blank" rel="noreferrer" className="touch-target relative inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              Read more<ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      )}
      {artist.genres.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">{artist.genres.map(genre => <Badge key={genre} tone="outline">{genre}</Badge>)}</div>
      )}
    </section>
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
