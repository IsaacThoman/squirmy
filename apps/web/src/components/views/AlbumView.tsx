import type { AlbumDetail } from '@squirmy/contracts'
import { CloudDownload, Disc3, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, MoreHorizontal, Plus } from 'lucide-react'
import { Fragment } from 'react'
import { Link, useNavigate } from 'react-router'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { TrackList } from '@/components/music/TrackList'
import { Badge } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu } from '@/components/ui/menu'
import { albumTypeLabel } from '@/lib/catalog'
import { formatDate, formatTotalDuration, plural } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { usePlayer } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'

const availabilityNote = {
  full: null,
  partial: (album: AlbumDetail) => `${album.ownedTrackCount} of ${album.trackCount} in your library`,
  on_demand: () => 'Plays on demand',
  none: () => 'Not in your library',
} as const

export function AlbumView({ album }: { album: AlbumDetail }) {
  const navigate = useNavigate()
  const library = useLibrary()
  const { controls } = usePlayer()
  const tracks = album.discs.flatMap(disc => disc.tracks)
  const context = { type: 'album' as const, id: album.id, title: album.title }
  const actions = useTrackActions(tracks, context)
  const wanted = library.isWanted(album.id, album.wanted)
  const playable = tracks.filter(track => track.availability !== 'none')

  const want = () => {
    library.setWanted({ type: 'album', album }, !wanted)
    toast({ title: wanted ? 'Removed from Wantlist' : 'Added to Wantlist', description: album.title })
  }
  const enqueue = (placement: 'next' | 'last') => {
    controls.enqueue(playable, placement)
    toast({ title: placement === 'next' ? 'Playing next' : 'Added to queue', description: album.title })
  }

  return (
    <div>
      <CollectionHeader
        kind={albumTypeLabel(album.type)}
        title={album.title}
        tint={album.artwork?.color}
        art={<Cover artwork={album.artwork} size={600} alt={`${album.title} cover`} dimmed={album.availability === 'none'} />}
        byline={album.artists.map((artist, index) => (
          <Fragment key={artist.id}>
            {index > 0 && ', '}
            <Link to={`/artist/${artist.id}`} className="hover:underline">{artist.name}</Link>
          </Fragment>
        ))}
        meta={[
          album.year ? String(album.year) : null,
          `${plural(album.trackCount, 'song')}, ${formatTotalDuration(album.durationMs)}`,
          availabilityNote[album.availability]?.(album),
        ]}
        actions={(
          <PlayActions
            title={album.title}
            onPlay={playable.length ? () => controls.playTracks(tracks, 0, context) : undefined}
            onShuffle={playable.length > 1 ? () => controls.playTracks(tracks, 0, context, { shuffle: true }) : undefined}
            liked={album.liked}
            onLike={() => library.setLiked('album', album.id, !album.liked)}
            wanted={wanted}
            onWant={album.availability === 'full' ? undefined : want}
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
                { kind: 'separator' },
                ...album.artists.map(artist => ({ label: `Go to ${artist.name}`, icon: <MicVocal />, onSelect: () => navigate(`/artist/${artist.id}`) })),
              ]}
              trigger={<IconButton label="More options" size="lg"><MoreHorizontal /></IconButton>}
            />
          </PlayActions>
        )}
      />

      <div className="px-(--gutter) pb-12">
        {album.availability === 'none' && (
          <div className="mb-6 flex flex-col gap-3 rounded-2xl bg-surface p-4 sm:flex-row sm:items-center">
            <Disc3 aria-hidden className="size-6 shrink-0 text-quiet" />
            <p className="flex-1 text-sm text-muted">
              This album is not in your library yet. {wanted ? 'It is on your Wantlist and will fill in when a matching import arrives.' : 'Add it to your Wantlist and a matching import will complete it.'}
            </p>
          </div>
        )}
        {album.availability === 'on_demand' && (
          <div className="mb-6 flex items-center gap-3 rounded-2xl bg-selection p-4 text-sm text-foreground">
            <CloudDownload aria-hidden className="size-5 shrink-0 text-accent" />
            Not on the server yet. Press play and it will be fetched; songs show as preparing until they arrive.
          </div>
        )}

        <TrackList label={`${album.title} tracks`} tracks={tracks} discs={album.discs} variant="album" {...actions} />

        <footer className="mt-10 flex flex-col gap-5 md:max-w-3xl">
          {album.description && <p className="text-[15px] leading-relaxed text-muted">{album.description}</p>}
          {album.genres.length > 0 && (
            <div className="flex flex-wrap gap-2">{album.genres.map(genre => <Badge key={genre} tone="outline" className="h-6 px-2.5 normal-case tracking-normal text-[12px]">{genre}</Badge>)}</div>
          )}
          <div className="text-xs leading-relaxed text-quiet">
            {album.releaseDate && <p>{formatDate(album.releaseDate)}</p>}
            {album.label && <p>℗ {album.year} {album.label}</p>}
          </div>
        </footer>
      </div>
    </div>
  )
}
