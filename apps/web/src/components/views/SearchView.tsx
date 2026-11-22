import type { SearchTop } from '@squirmy/client-core'
import type { AlbumSummary, TrackSummary } from '@squirmy/contracts'
import { Pause, Play, Search } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import type { SearchState } from '@/api/use-search'
import { Page, PageHeader } from '@/components/layout/Page'
import { AlbumCard, ArtistCard, GenreTile, Monogram } from '@/components/music/Cards'
import { PrefetchLink } from '@/components/music/PrefetchLink'
import { Cover } from '@/components/music/Cover'
import { Rail, RailItem } from '@/components/music/Rail'
import { SectionHeader } from '@/components/music/SectionHeader'
import { RailSkeleton, TrackRowsSkeleton } from '@/components/music/Skeletons'
import { TrackList } from '@/components/music/TrackList'
import { Badge, EmptyState, Skeleton } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { SearchField } from '@/components/ui/search-field'
import { albumPresentation, albumTypeLabel, canFetch, genreColor, isPlayable } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useViewer } from '@/player/on-demand-context'
import { usePlayer, usePlayerControls } from '@/player/player-context'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'

type SearchViewProps = {
  query: string
  onQueryChange: (query: string) => void
  search: SearchState
  genres: string[]
  onBrowseGenre: (genre: string) => void
  onPlayAlbum: (album: AlbumSummary) => void
}

/** How many songs the page lists. */
const SONGS = 10
const searchContext = { type: 'search', id: null, title: 'Search' } as const

/**
 * One set of results for what is typed: the top result, then artists, albums and songs. Music
 * on the server and music it can fetch are listed together, the user's own first, and look
 * the same; what does not play is gray and comes last. Enter plays or opens the top result.
 */
export function SearchView({ query, onQueryChange, search, genres, onBrowseGenre, onPlayAlbum }: SearchViewProps) {
  const active = query.trim().length > 0
  const { results, stale, catalogPending, unavailable } = search
  const openTop = useOpenTop(onPlayAlbum)
  const count = results ? results.artists.length + results.albums.length + results.tracks.length : 0
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !results?.top || stale) return
    event.preventDefault()
    openTop(results.top)
  }
  return (
    <>
      {/* The field follows the title and takes the room there is, instead of sitting at the far end like a page's controls. */}
      <PageHeader title="Search" controls="fill">
        <SearchField value={query} onValueChange={onQueryChange} onKeyDown={onKeyDown} aria-label="Search" placeholder="Songs, albums, artists" autoFocus className="w-full max-w-md" />
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
        {active && !unavailable && !results && <ResultsSkeleton />}
        {active && !unavailable && results && (
          count === 0 && !catalogPending && !stale
            ? <EmptyState icon={<Search />} title={`No results for “${query.trim()}”`} description="Check the spelling, or try an artist, album or song name." />
            : (
              <div aria-busy={stale || catalogPending || undefined} className={cn('flex flex-col gap-8 transition-opacity', stale && 'opacity-60')}>
                {results.top
                  ? <TopResult top={results.top} onOpen={openTop} />
                  : catalogPending && !stale && <TopSkeleton />}
                {results.artists.length > 0
                  ? <Rail title="Artists">{results.artists.map(artist => <RailItem key={artist.id}><ArtistCard artist={artist} /></RailItem>)}</Rail>
                  : catalogPending && <RailSkeleton />}
                {results.albums.length > 0
                  ? <AlbumResults albums={results.albums} onPlayAlbum={onPlayAlbum} />
                  : catalogPending && <RailSkeleton />}
                <SongResults tracks={results.tracks} pending={catalogPending} />
              </div>
            )
        )}
      </Page>
    </>
  )
}

function AlbumResults({ albums, onPlayAlbum }: { albums: AlbumSummary[]; onPlayAlbum: (album: AlbumSummary) => void }) {
  const wants = useAlbumWants()
  return <Rail title="Albums">{albums.map(album => <RailItem key={album.id}><AlbumCard album={album} onPlay={() => onPlayAlbum(album)} {...wants(album)} /></RailItem>)}</Rail>
}

/** The songs, and while the catalog's answer is on its way, room for the songs it adds below them. */
function SongResults({ tracks, pending }: { tracks: TrackSummary[]; pending: boolean }) {
  const shown = tracks.slice(0, SONGS)
  const actions = useTrackActions(shown, searchContext)
  if (!shown.length && !pending) return null
  return (
    <section aria-labelledby="search-songs">
      <SectionHeader id="search-songs" title="Songs" className="mb-1" />
      {shown.length > 0 && <div className="-mx-2"><TrackList label="Songs" tracks={shown} variant="compact" header={false} {...actions} /></div>}
      {pending && shown.length < SONGS && <TrackRowsSkeleton rows={Math.min(4, SONGS - shown.length)} art />}
    </section>
  )
}

/** Plays a top result that plays (a song, an album), and opens the rest: an artist, or the album of a song that does not. */
function useOpenTop(onPlayAlbum: (album: AlbumSummary) => void) {
  const navigate = useNavigate()
  const controls = usePlayerControls()
  const viewer = useViewer()
  return (top: SearchTop) => {
    if (top.type === 'artist') return void navigate(`/artist/${top.artist.id}`)
    if (top.type === 'album') {
      if (albumPresentation(top.album, viewer) === 'normal') onPlayAlbum(top.album)
      else void navigate(`/album/${top.album.id}`)
      return
    }
    if (isPlayable(top.track, viewer)) controls.playTracks([top.track], 0, { type: 'search', id: null, title: 'Top result' })
    else if (top.track.album) void navigate(`/album/${top.track.album.id}`)
  }
}

/** The best match, large: opens its page, and plays it when it plays. */
function TopResult({ top, onOpen }: { top: SearchTop; onOpen: (top: SearchTop) => void }) {
  const { state, controls } = usePlayer()
  const viewer = useViewer()
  // A song that is already the current track pauses and resumes, as its track row does.
  const current = top.type === 'track' && state.current?.track.id === top.track.id
  const playing = current && state.playing
  const plays = top.type === 'album' ? albumPresentation(top.album, viewer) === 'normal' : top.type === 'track' && isPlayable(top.track, viewer)
  const dimmed = top.type === 'artist' ? !top.artist.inLibrary && !canFetch(viewer) : !plays
  const item = top.type === 'artist'
    ? { title: top.artist.name, kind: 'Artist', by: null, to: `/artist/${top.artist.id}` }
    : top.type === 'album'
      ? { title: top.album.title, kind: albumTypeLabel(top.album.type), by: top.album.artistCredit, to: `/album/${top.album.id}` }
      : { title: top.track.title, kind: 'Song', by: top.track.artistCredit, to: top.track.album ? `/album/${top.track.album.id}` : null }
  const play = current ? controls.togglePlay : plays ? () => onOpen(top) : null
  const art = top.type === 'artist'
    ? top.artist.image ? <Cover artwork={top.artist.image} round dimmed={dimmed} size={300} /> : <Monogram name={top.artist.name} className="text-3xl" />
    : <Cover artwork={top.type === 'album' ? top.album.artwork : top.track.album?.artwork ?? null} dimmed={dimmed} size={300} />
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
            ? <PrefetchLink {...target} to={item.to} title={item.title} className={cn(titleClass, 'outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring', dimmed && 'text-muted-foreground')}>{item.title}</PrefetchLink>
            : <p title={item.title} className={titleClass}>{item.title}</p>}
          <p className="mt-1.5 flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <Badge>{item.kind}</Badge>
            {item.by && <span className="truncate" title={item.by}>{item.by}</span>}
          </p>
        </div>
        {play && (
          <IconButton label={`${playing ? 'Pause' : 'Play'} ${item.title}`} tooltip={false} variant="primary" size="lg" shape="round" onClick={play} className="z-10 mr-1">
            {playing ? <Pause fill="currentColor" /> : <Play className="translate-x-px" fill="currentColor" />}
          </IconButton>
        )}
      </div>
    </section>
  )
}

/** The top result's card while the catalog may still name one. */
function TopSkeleton() {
  return (
    <div aria-hidden>
      <div className="mb-3 flex h-8 items-center"><Skeleton className="h-4 w-28" /></div>
      <div className="flex max-w-lg items-center gap-4 rounded-xl border p-3">
        <Skeleton className="size-20 shrink-0 rounded-cover" />
        <div className="flex flex-1 flex-col gap-2.5"><Skeleton className="h-5 w-44" /><Skeleton className="h-3 w-24" /></div>
      </div>
    </div>
  )
}

function ResultsSkeleton() {
  return (
    <div role="status" aria-label="Searching" className="flex flex-col gap-8">
      <TopSkeleton />
      <RailSkeleton />
      <TrackRowsSkeleton rows={4} art />
    </div>
  )
}
