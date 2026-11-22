import type { AlbumDetail, AlbumSummary, ArtistDetail } from '@squirmy/contracts'
import { MoreHorizontal, Music, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useCurrentUser } from '@/auth/session'
import { FixMatch } from '@/components/admin/FixMatch'
import { ArtistLinks } from '@/components/music/ArtistLinks'
import { AlbumCard } from '@/components/music/Cards'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { albumMenuEntries } from '@/components/music/album-menu'
import { Rail, RailItem } from '@/components/music/Rail'
import { TrackRowsSkeleton } from '@/components/music/Skeletons'
import { TrackList } from '@/components/music/TrackList'
import { Button } from '@/components/ui/button'
import { Badge, EmptyState } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { albumNote, albumPresentation, albumTypeLabel, awaitsTrackList, isPlayable, relatedAlbums } from '@/lib/catalog'
import { formatReleaseDate, formatTotalDuration, plural } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'

/**
 * How long a track list may stay "loading" before the page stops waiting on screen: about as
 * long as the page keeps asking the server (`useAlbum`). The server's invalidation still
 * brings the songs when they come.
 */
export const TRACK_LIST_WAIT_MS = 60_000

type AlbumViewProps = {
  album: AlbumDetail
  /** The lead artist's page, once loaded: other versions of the album and more by them follow the songs. */
  artist?: ArtistDetail
  onPlayAlbum?: (album: AlbumSummary) => void
  /** Asks the server for the album again, from the "still looking" state. */
  onRefresh?: () => void
}

/**
 * One layout for every album, wherever its music is: the header, Play, Shuffle, the heart (which
 * saves it to the library), and the full track list. Nothing says what is on the server; a member who may not
 * fetch music sees gray rows and, for a partial album, one line of how much plays.
 */
export function AlbumView({ album, artist, onPlayAlbum, onRefresh }: AlbumViewProps) {
  const navigate = useNavigate()
  const library = useLibrary()
  const viewer = useViewer()
  const user = useCurrentUser()
  const controls = usePlayerControls()
  const [fixing, setFixing] = useState(false)
  const tracks = album.discs.flatMap(disc => disc.tracks)
  const context = { type: 'album' as const, id: album.id, title: album.title }
  const actions = useTrackActions(tracks, context)
  const wanted = library.isWanted(album.id, album.wanted)
  const playable = tracks.filter(track => isPlayable(track, viewer))
  const dimmed = albumPresentation(album, viewer) === 'dimmed'
  // The songs are on their way. Play can be pressed already, for music that plays; it starts once they arrive.
  const awaiting = awaitsTrackList(album)
  const overdue = useOverdue(awaiting, album.id)
  const listing = awaiting && !overdue
  const waiting = listing && !dimmed
  const { versions, more } = relatedAlbums(album, artist)
  const [queued, setQueued] = useState<'play' | 'shuffle' | null>(null)
  const owned = album.availability === 'full' || album.availability === 'partial'

  const play = (shuffle: boolean) => {
    if (playable.length) controls.playTracks(tracks, 0, context, { shuffle })
    else setQueued(shuffle ? 'shuffle' : 'play')
  }
  // Pressed while the songs were on their way: it plays once, when they arrive.
  const arrived = playable.length > 0
  const pending = queued !== null && !arrived
  useEffect(() => {
    if (queued && arrived) controls.playTracks(tracks, 0, context, { shuffle: queued === 'shuffle' })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- only the arrival plays; later changes to the list do not
  }, [queued, arrived])

  const want = () => {
    library.setWanted({ type: 'album', album }, !wanted)
    toast({ title: wanted ? 'Removed from Wantlist' : 'Added to Wantlist', description: album.title })
  }
  const toggleSaved = () => library.setSaved({ type: 'album', id: album.id, title: album.title }, !album.liked)
  const enqueue = (placement: 'next' | 'last') => {
    controls.enqueue(playable, placement)
    toast({ title: placement === 'next' ? 'Playing next' : 'Added to queue', description: album.title })
  }
  const note = albumNote(album, viewer)

  return (
    <div>
      <CollectionHeader
        kind={albumTypeLabel(album.type)}
        title={album.title}
        tint={album.artwork?.color}
        art={<Cover artwork={album.artwork} size={600} alt={`${album.title} cover`} dimmed={dimmed} />}
        byline={<ArtistLinks credit={album} />}
        meta={[
          album.year ? String(album.year) : null,
          // The songs listed, as the iOS app counts them: `trackCount` can run ahead of the list while it fills in.
          tracks.length > 0 && `${plural(tracks.length, 'song')}, ${formatTotalDuration(album.durationMs)}`,
          note,
        ]}
        actions={(
          <PlayActions
            title={album.title}
            onPlay={playable.length || waiting ? () => play(false) : undefined}
            onShuffle={playable.length > 1 || waiting ? () => play(true) : undefined}
            pending={pending}
            liked={album.liked}
            onLike={toggleSaved}
            wanted={wanted}
            onWant={library.wantlistEnabled && dimmed ? want : undefined}
          >
            <DropdownMenu
              align="start"
              entries={[
                ...albumMenuEntries({
                  artists: album.artists,
                  playable: playable.length > 0,
                  onEnqueue: enqueue,
                  playlists: library.playlists,
                  onAddToPlaylist: playlist => (playlist ? library.addToPlaylist(playlist, tracks) : library.newPlaylist(tracks)),
                  liked: album.liked,
                  onToggleSaved: toggleSaved,
                  want: library.wantlistEnabled && dimmed ? { wanted, onToggle: want } : undefined,
                  onGoToArtist: artist => void navigate(`/artist/${artist.id}`),
                }),
                ...(user.role === 'admin' && owned ? [{ kind: 'separator' }, { label: 'Fix match…', icon: <Wand2 />, onSelect: () => setFixing(true) }] satisfies MenuEntry[] : []),
              ]}
              trigger={<IconButton label="More options" size="lg"><MoreHorizontal /></IconButton>}
            />
          </PlayActions>
        )}
      />

      <div className="px-(--gutter) pb-10">
        {listing
          ? <div role="status" aria-label="Loading songs" className="px-2 pt-2"><TrackRowsSkeleton rows={Math.min(Math.max(album.trackCount, 6), 14)} /></div>
          : tracks.length
            ? <div className="-mx-2"><TrackList label={`${album.title} tracks`} tracks={tracks} discs={album.discs} variant="album" {...actions} /></div>
            : overdue
              ? (
                <EmptyState
                  icon={<Music />}
                  title="Still looking for the songs"
                  description="This is taking longer than usual. They will show up here when they arrive."
                  action={onRefresh && <Button variant="outline" onClick={onRefresh}>Check again</Button>}
                />
              )
              : <EmptyState icon={<Music />} title="No songs listed" description="The server doesn’t know this album’s songs yet." />}

        <footer className="mt-8 flex flex-col gap-4 md:max-w-2xl">
          {album.description && <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{album.description}</p>}
          {album.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">{album.genres.map(genre => <Badge key={genre} tone="outline">{genre}</Badge>)}</div>
          )}
          {(album.releaseDate || album.label) && (
            <div className="text-xs leading-relaxed text-muted-foreground">
              {album.releaseDate && <p>{formatReleaseDate(album.releaseDate)}</p>}
              {album.label && <p>℗ {album.year} {album.label}</p>}
            </div>
          )}
        </footer>

        {(versions.length > 0 || more.length > 0) && (
          <div className="mt-10 flex flex-col gap-8">
            {versions.length > 0 && <AlbumRail title="Other versions" albums={versions} onPlayAlbum={onPlayAlbum} />}
            {more.length > 0 && artist && <AlbumRail title={`More by ${artist.name}`} href={`/artist/${artist.id}`} albums={more} onPlayAlbum={onPlayAlbum} />}
          </div>
        )}
      </div>
      {fixing && (
        <FixMatch
          albumId={album.id}
          onOpenChange={setFixing}
          onDone={result => { if (result.albumId && result.albumId !== album.id) void navigate(`/album/${result.albumId}`, { replace: true }) }}
        />
      )}
    </div>
  )
}

function AlbumRail({ title, href, albums, onPlayAlbum }: { title: string; href?: string; albums: AlbumSummary[]; onPlayAlbum?: (album: AlbumSummary) => void }) {
  return (
    <Rail title={title} href={href}>
      {albums.map(other => (
        <RailItem key={other.id}><AlbumCard album={other} subtitle="year" onPlay={onPlayAlbum && (() => onPlayAlbum(other))} /></RailItem>
      ))}
    </Rail>
  )
}

/** True once the album has waited `TRACK_LIST_WAIT_MS` for its songs on this page. */
function useOverdue(awaiting: boolean, albumId: string): boolean {
  const [overdue, setOverdue] = useState<string | null>(null)
  useEffect(() => {
    if (!awaiting) return
    const timer = setTimeout(() => setOverdue(albumId), TRACK_LIST_WAIT_MS)
    return () => clearTimeout(timer)
  }, [awaiting, albumId])
  return awaiting && overdue === albumId
}
