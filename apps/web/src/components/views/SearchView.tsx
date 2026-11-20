import type { AlbumSummary, SearchResults } from '@squirmy/contracts'
import { Search } from 'lucide-react'
import { Page } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, GenreTile } from '@/components/music/Cards'
import { Rail, RailItem } from '@/components/music/Rail'
import { PageTitle, SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { EmptyState, Skeleton } from '@/components/ui/feedback'
import { SearchField } from '@/components/ui/search-field'
import { genreColor } from '@/lib/catalog'
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
      <div className="flex items-baseline gap-3 border-b border-stroke pb-3">
        <h2 className="text-[26px] font-extrabold tracking-[-0.04em]">{title}</h2>
        {note && <p className="text-[13px] font-medium text-quiet">{note}</p>}
      </div>
      {results.tracks.length > 0 && (
        <div>
          <SectionHeader title="Songs" />
          <div className="-mx-2"><TrackList label={`${title}: songs`} tracks={results.tracks.slice(0, 6)} variant="compact" header={false} {...actions} /></div>
        </div>
      )}
      {results.albums.length > 0 && (
        <Rail title="Albums">
          {results.albums.map(album => <RailItem key={album.id}><AlbumCard album={album} onPlay={() => onPlayAlbum(album)} {...wants(album)} /></RailItem>)}
        </Rail>
      )}
      {results.artists.length > 0 && (
        <Rail title="Artists">
          {results.artists.map(artist => <RailItem key={artist.id}><ArtistCard artist={artist} /></RailItem>)}
        </Rail>
      )}
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
