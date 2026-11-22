import type { AlbumSummary, ArtistSummary, SearchResults, TrackSummary } from '@squirmy/contracts'
import { Pause, Play, Search } from 'lucide-react'
import { Page, PageHeader } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, GenreTile, Monogram } from '@/components/music/Cards'
import { PrefetchLink } from '@/components/music/PrefetchLink'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { Badge, EmptyState, Skeleton } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { SearchField } from '@/components/ui/search-field'
import { albumTypeLabel, genreColor, isUnowned } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { usePlayer } from '@/player/player-context'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'

type SearchViewProps = {
  query: string
  onQueryChange: (query: string) => void
  /** Owned music, from the library search. Null with no query or no answer. */
  library: SearchResults | null
  /** Everything else, from the catalog search provider; shown gray. */
  catalog: SearchResults | null
  libraryLoading?: boolean
  catalogLoading?: boolean
  /** The server has no search yet. */
  unavailable?: boolean
  genres: string[]
  onBrowseGenre: (genre: string) => void
  onPlayAlbum: (album: AlbumSummary) => void
}

const isEmpty = (results: SearchResults | null) => !results || results.artists.length + results.albums.length + results.tracks.length === 0

export function SearchView({ query, onQueryChange, library, catalog, libraryLoading, catalogLoading, unavailable, genres, onBrowseGenre, onPlayAlbum }: SearchViewProps) {
  const active = query.trim().length > 0
  // The library's best match leads; without one, the catalog's.
  const top = topResult(library) ?? (libraryLoading ? null : topResult(catalog))
  return (
    <>
      {/* The field follows the title and takes the room there is, instead of sitting at the far end like a page's controls. */}
      <PageHeader title="Search" controls="fill">
        <SearchField value={query} onValueChange={onQueryChange} aria-label="Search" placeholder="Songs, albums, artists" autoFocus className="w-full max-w-md" />
      </PageHeader>
      <Page className="flex flex-col gap-8">
        {!active && genres.length > 0 && (
          <section>
            <SectionHeader title="Browse by genre" />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {genres.map(genre => <GenreTile key={genre} name={genre} color={genreColor(genre)} onClick={() => onBrowseGenre(genre)} />)}
            </div>
          </section>
        )}

        {active && unavailable && (
          <EmptyState icon={<Search />} title="Search is not available yet" description="This server does not answer searches yet. Browse your library in the meantime." />
        )}
        {active && !unavailable && (
          <>
            {top && <TopResult top={top} onPlayAlbum={onPlayAlbum} />}
            {libraryLoading && <ResultsSkeleton label="Searching your library" />}
            {!isEmpty(library) && library && <Results title="In your library" results={library} onPlayAlbum={onPlayAlbum} />}
            {catalogLoading && <ResultsSkeleton label="Searching the catalog" />}
            {!catalogLoading && !isEmpty(catalog) && catalog && (
              <Results title="More to discover" note={catalog.provider ? `Not in your library · from ${providerName(catalog.provider)}` : 'Not in your library'} results={catalog} onPlayAlbum={onPlayAlbum} />
            )}
            {isEmpty(library) && !libraryLoading && !catalogLoading && isEmpty(catalog) && (
              <EmptyState icon={<Search />} title={`No results for “${query.trim()}”`} description="Check the spelling, or try an artist, album or song name." />
            )}
          </>
        )}
      </Page>
    </>
  )
}

function providerName(provider: string) {
  return { deezer: 'Deezer', musicbrainz: 'MusicBrainz', 'local-index': 'the local index' }[provider] ?? provider
}

/** One search's results under a ruled heading: artists, albums, then songs. */
function Results({ title, note, results, onPlayAlbum }: { title: string; note?: string; results: SearchResults; onPlayAlbum: (album: AlbumSummary) => void }) {
  const actions = useTrackActions(results.tracks, { type: 'search', id: null, title })
  const wants = useAlbumWants()
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3 border-b pb-2.5">
        <h2 className="shrink-0 text-base font-semibold">{title}</h2>
        {note && <p className="truncate text-xs text-muted-foreground">{note}</p>}
      </div>
      {results.artists.length > 0 && (
        <Rail title="Artists" quiet>
          {results.artists.map(artist => <RailItem key={artist.id}><ArtistCard artist={artist} /></RailItem>)}
        </Rail>
      )}
      {results.albums.length > 0 && (
        <Rail title="Albums" quiet>
          {results.albums.map(album => <RailItem key={album.id}><AlbumCard album={album} onPlay={() => onPlayAlbum(album)} {...wants(album)} /></RailItem>)}
        </Rail>
      )}
      {results.tracks.length > 0 && (
        <div>
          <SectionHeader title="Songs" quiet className="mb-1" />
          <div className="-mx-2"><TrackList label={`${title}: songs`} tracks={results.tracks.slice(0, 6)} variant="compact" header={false} {...actions} /></div>
        </div>
      )}
    </section>
  )
}

/** The item a result list's `top` hint names, looked up in its lists. */
type Top = { type: 'artist'; artist: ArtistSummary } | { type: 'album'; album: AlbumSummary } | { type: 'track'; track: TrackSummary }

function topResult(results: SearchResults | null): Top | null {
  const top = results?.top
  if (!results || !top) return null
  const byId = <T extends { id: string }>(items: T[]) => items.find(item => item.id === top.id)
  if (top.type === 'artist') {
    const artist = byId(results.artists)
    return artist ? { type: 'artist', artist } : null
  }
  if (top.type === 'album') {
    const album = byId(results.albums)
    return album ? { type: 'album', album } : null
  }
  const track = byId(results.tracks)
  return track ? { type: 'track', track } : null
}

/** The best match, large: opens its page, and plays it when it is on the server. */
function TopResult({ top, onPlayAlbum }: { top: Top; onPlayAlbum: (album: AlbumSummary) => void }) {
  const { state, controls } = usePlayer()
  // A song that is already the current track pauses and resumes, as its track row does.
  const current = top.type === 'track' && state.current?.track.id === top.track.id
  const playing = current && state.playing
  const item = top.type === 'artist'
    ? { title: top.artist.name, kind: 'Artist', by: null, to: `/artist/${top.artist.id}`, owned: top.artist.inLibrary, play: null }
    : top.type === 'album'
      ? {
        title: top.album.title, kind: albumTypeLabel(top.album.type), by: top.album.artistCredit, to: `/album/${top.album.id}`, owned: !isUnowned(top.album),
        play: isUnowned(top.album) ? null : () => onPlayAlbum(top.album),
      }
      : {
        title: top.track.title, kind: 'Song', by: top.track.artistCredit, to: top.track.album ? `/album/${top.track.album.id}` : null, owned: top.track.availability === 'server',
        play: current
          ? controls.togglePlay
          : top.track.availability === 'server' ? () => controls.playTracks([top.track], 0, { type: 'search', id: null, title: 'Top result' }) : null,
      }
  const art = top.type === 'artist'
    ? top.artist.image ? <Cover artwork={top.artist.image} round dimmed={!item.owned} size={300} /> : <Monogram name={top.artist.name} className="text-3xl" />
    : <Cover artwork={top.type === 'album' ? top.album.artwork : top.track.album?.artwork ?? null} dimmed={!item.owned} size={300} />
  // What the title opens: the artist, the album, or the song's album.
  const target = top.type === 'artist'
    ? { kind: 'artist' as const, id: top.artist.id }
    : { kind: 'album' as const, id: top.type === 'album' ? top.album.id : top.track.album?.id ?? '' }
  const titleClass = 'block truncate text-xl font-semibold tracking-tight'
  return (
    <section aria-labelledby="search-top">
      <SectionHeader id="search-top" title="Top result" />
      <div className="relative flex max-w-lg items-center gap-4 rounded-xl border bg-card p-3 transition-colors has-[a:hover]:bg-accent/60">
        <div className="w-20 shrink-0">{art}</div>
        <div className="min-w-0 flex-1">
          {item.to
            ? <PrefetchLink {...target} to={item.to} title={item.title} className={cn(titleClass, 'outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring', !item.owned && 'text-muted-foreground')}>{item.title}</PrefetchLink>
            : <p title={item.title} className={titleClass}>{item.title}</p>}
          <p className="mt-1.5 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <Badge>{item.kind}</Badge>
            {item.by && <span className="truncate" title={item.by}>{item.by}</span>}
          </p>
        </div>
        {item.play && (
          <IconButton label={`${playing ? 'Pause' : 'Play'} ${item.title}`} tooltip={false} variant="primary" size="lg" shape="round" onClick={item.play} className="z-10 mr-1">
            {playing ? <Pause fill="currentColor" /> : <Play className="translate-x-px" fill="currentColor" />}
          </IconButton>
        )}
      </div>
    </section>
  )
}

function ResultsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col">
      <div className="mb-4 border-b pb-3"><Skeleton className="h-4 w-36" /></div>
      {[0, 1, 2].map(row => (
        <div key={row} className="flex h-11 items-center gap-3">
          <Skeleton className="size-8 rounded-[5px]" />
          <div className="flex flex-col gap-2"><Skeleton className="h-3 w-48" /><Skeleton className="h-2.5 w-28" /></div>
        </div>
      ))}
    </div>
  )
}
