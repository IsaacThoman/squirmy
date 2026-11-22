import type { AlbumDetail } from '@squirmy/contracts'
import { BookmarkCheck, BookmarkPlus, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, MoreHorizontal, Plus, Wand2 } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useCurrentUser } from '@/auth/session'
import { FixMatch } from '@/components/admin/FixMatch'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { librarySaveEntry } from '@/components/music/library-save-entry'
import { TrackRowsSkeleton } from '@/components/music/Skeletons'
import { TrackList } from '@/components/music/TrackList'
import { Badge } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { albumNote, albumPresentation, albumTypeLabel, awaitsTrackList, isPlayable } from '@/lib/catalog'
import { formatDate, formatTotalDuration, plural } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { useViewer } from '@/player/on-demand-context'
import { usePlayerControls } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'

/**
 * One layout for every album, wherever its music is: the header, Play, Shuffle, the heart (which
 * saves it to the library), and the full track list. Nothing says what is on the server; a member who may not
 * fetch music sees gray rows and, for a partial album, one line of how much plays.
 */
export function AlbumView({ album }: { album: AlbumDetail }) {
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
  const listing = awaitsTrackList(album)
  const waiting = listing && !dimmed
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
        byline={album.artists.map((artist, index) => (
          <Fragment key={artist.id}>
            {index > 0 && ', '}
            <Link to={`/artist/${artist.id}`} className="hover:underline">{artist.name}</Link>
          </Fragment>
        ))}
        meta={[
          album.year ? String(album.year) : null,
          tracks.length > 0 && `${plural(album.trackCount, 'song')}, ${formatTotalDuration(album.durationMs)}`,
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
                { label: 'Play next', icon: <ListStart />, disabled: !playable.length, onSelect: () => enqueue('next') },
                { label: 'Add to queue', icon: <ListEnd />, disabled: !playable.length, onSelect: () => enqueue('last') },
                {
                  kind: 'submenu',
                  label: 'Add to playlist',
                  icon: <ListPlus />,
                  items: [
                    { label: 'New playlist…', icon: <Plus />, onSelect: () => library.newPlaylist(tracks) },
                    ...(library.playlists.length ? [{ kind: 'separator' as const }] : []),
                    ...library.playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => library.addToPlaylist(playlist, tracks) })),
                  ],
                },
                librarySaveEntry(album, toggleSaved),
                ...(library.wantlistEnabled && dimmed ? [{ label: wanted ? 'Remove from Wantlist' : 'Add to Wantlist', icon: wanted ? <BookmarkCheck /> : <BookmarkPlus />, onSelect: want }] : []),
                { kind: 'separator' },
                ...album.artists.map(artist => ({ label: `Go to ${artist.name}`, icon: <MicVocal />, onSelect: () => navigate(`/artist/${artist.id}`) })),
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
          : <div className="-mx-2"><TrackList label={`${album.title} tracks`} tracks={tracks} discs={album.discs} variant="album" {...actions} /></div>}

        <footer className="mt-8 flex flex-col gap-4 md:max-w-2xl">
          {album.description && <p className="text-pretty text-sm leading-relaxed text-muted-foreground">{album.description}</p>}
          {album.genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5">{album.genres.map(genre => <Badge key={genre} tone="outline">{genre}</Badge>)}</div>
          )}
          {(album.releaseDate || album.label) && (
            <div className="text-xs leading-relaxed text-muted-foreground">
              {album.releaseDate && <p>{formatDate(album.releaseDate)}</p>}
              {album.label && <p>℗ {album.year} {album.label}</p>}
            </div>
          )}
        </footer>
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
