import type { AlbumSummary, ArtistSummary, SearchResults, TrackSummary } from '@squirmy/contracts'
import { Play, Search } from 'lucide-react'
import { Link } from 'react-router'
import { Page } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, GenreTile, Monogram } from '@/components/music/Cards'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { PageTitle, SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { EmptyState, Skeleton } from '@/components/ui/feedback'
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
    <Page className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <PageTitle>Search</PageTitle>
        <SearchField value={query} onValueChange={onQueryChange} size="lg" placeholder="Songs, albums, artists" autoFocus className="md:hidden" />
      </div>

      {!active && genres.length > 0 && (
        <section>
          <SectionHeader title="Browse by genre" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
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
  )
}

function providerName(provider: string) {
  return { deezer: 'Deezer', musicbrainz: 'MusicBrainz', 'local-index': 'the local index' }[provider] ?? provider
}

function Results({ title, note, results, onPlayAlbum }: { title: string; note?: string; results: SearchResults; onPlayAlbum: (album: AlbumSummary) => void }) {
  const actions = useTrackActions(results.tracks, { type: 'search', id: null, title })
  const wants = useAlbumWants()
  return (
    <section aria-label={title} className="flex flex-col gap-7">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-stroke pb-3">
        <h2 className="text-[26px] font-extrabold tracking-[-0.04em]">{title}</h2>
        {note && <p className="text-[13px] font-medium text-quiet">{note}</p>}
      </div>
      {results.artists.length > 0 && (
        <Rail title="Artists">
          {results.artists.map(artist => <RailItem key={artist.id}><ArtistCard artist={artist} /></RailItem>)}
        </Rail>
      )}
      {results.albums.length > 0 && (
        <Rail title="Albums">
          {results.albums.map(album => <RailItem key={album.id}><AlbumCard album={album} onPlay={() => onPlayAlbum(album)} {...wants(album)} /></RailItem>)}
        </Rail>
      )}
      {results.tracks.length > 0 && (
        <div className="rounded-xl border border-stroke bg-sheet p-3 md:p-4">
          <SectionHeader title="Songs" className="mb-1.5 px-1" />
          <TrackList label={`${title}: songs`} tracks={results.tracks.slice(0, 6)} variant="compact" header={false} {...actions} />
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
  const { controls } = usePlayer()
  const item = top.type === 'artist'
    ? { title: top.artist.name, kind: 'Artist', by: null, to: `/artist/${top.artist.id}`, owned: top.artist.inLibrary, play: null }
    : top.type === 'album'
      ? {
        title: top.album.title, kind: albumTypeLabel(top.album.type), by: top.album.artistCredit, to: `/album/${top.album.id}`, owned: !isUnowned(top.album),
        play: isUnowned(top.album) ? null : () => onPlayAlbum(top.album),
      }
      : {
        title: top.track.title, kind: 'Song', by: top.track.artistCredit, to: top.track.album ? `/album/${top.track.album.id}` : null, owned: top.track.availability === 'server',
        play: top.track.availability === 'server' ? () => controls.playTracks([top.track], 0, { type: 'search', id: null, title: 'Top result' }) : null,
      }
  const art = top.type === 'artist'
    ? top.artist.image ? <Cover artwork={top.artist.image} round dimmed={!item.owned} size={300} /> : <Monogram name={top.artist.name} />
    : <Cover artwork={top.type === 'album' ? top.album.artwork : top.track.album?.artwork ?? null} dimmed={!item.owned} size={300} className="shadow-cover" />
  return (
    <section aria-labelledby="search-top">
      <SectionHeader id="search-top" title="Top result" />
      <div className="group/top relative flex max-w-xl items-center gap-3 rounded-xl border border-stroke bg-sheet p-3 transition-colors hover:bg-overlay focus-within:bg-overlay focus-within:ring-1 focus-within:ring-accent sm:gap-5 sm:p-5">
        <div className="w-16 shrink-0 sm:w-28">{art}</div>
        <div className="min-w-0 flex-1">
          {item.to
            ? <Link to={item.to} title={item.title} className={cn('block truncate text-2xl font-extrabold tracking-[-0.03em] after:absolute after:inset-0 after:rounded-xl focus-visible:outline-none sm:text-[28px]', !item.owned && 'text-muted')}>{item.title}</Link>
            : <p title={item.title} className="truncate text-2xl font-extrabold tracking-[-0.03em] sm:text-[28px]">{item.title}</p>}
          <p className="mt-1 flex min-w-0 items-center gap-2 text-sm text-muted">
            <span className="shrink-0 rounded-full bg-surface px-2.5 py-0.5 text-xs font-semibold text-foreground">{item.kind}</span>
            {item.by && <span className="truncate" title={item.by}>{item.by}</span>}
          </p>
        </div>
        {item.play && (
          <button
            type="button"
            aria-label={`Play ${item.title}`}
            onClick={item.play}
            className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full bg-accent sm:size-12 text-on-accent shadow-cover transition duration-150 hover:scale-105"
          >
            <Play className="size-5 translate-x-px" fill="currentColor" />
          </button>
        )}
      </div>
    </section>
  )
}

function ResultsSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-3">
      <Skeleton className="h-8 w-56" />
      {[0, 1, 2].map(row => (
        <div key={row} className="flex items-center gap-3 py-2">
          <Skeleton className="size-10" />
          <div className="flex flex-col gap-2"><Skeleton className="h-3.5 w-48" /><Skeleton className="h-3 w-28" /></div>
        </div>
      ))}
    </div>
  )
}
