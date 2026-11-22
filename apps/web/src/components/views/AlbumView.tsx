import type { AlbumDetail } from '@squirmy/contracts'
import { CloudDownload, Disc3, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, MoreHorizontal, Plus, Wand2 } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useCurrentUser } from '@/auth/session'
import { FixMatch } from '@/components/admin/FixMatch'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { REQUEST_NOT_ALLOWED, TrackList } from '@/components/music/TrackList'
import { Button } from '@/components/ui/button'
import { Badge, ProgressBar } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu, type MenuEntry } from '@/components/ui/menu'
import { albumTypeLabel, isPlayable } from '@/lib/catalog'
import { formatDate, formatTotalDuration, plural } from '@/lib/format'
import { toast } from '@/lib/toast'
import { useLibrary } from '@/player/library-context'
import { useOnDemand } from '@/player/on-demand-context'
import { usePlayer } from '@/player/player-context'
import { useTrackActions } from '@/player/use-track-actions'

const availabilityNote = {
  full: null,
  partial: (album: AlbumDetail) => `${album.ownedTrackCount} of ${album.trackCount} in your library`,
  on_demand: (_album: AlbumDetail, canRequest: boolean) => (canRequest ? 'Plays on demand' : 'Not on the server'),
  none: () => 'Not in your library',
} as const

export function AlbumView({ album }: { album: AlbumDetail }) {
  const navigate = useNavigate()
  const library = useLibrary()
  const onDemand = useOnDemand()
  const user = useCurrentUser()
  const { controls } = usePlayer()
  const [fixing, setFixing] = useState(false)
  const tracks = album.discs.flatMap(disc => disc.tracks)
  const context = { type: 'album' as const, id: album.id, title: album.title }
  const actions = useTrackActions(tracks, context)
  const wanted = library.isWanted(album.id, album.wanted)
  const playable = tracks.filter(track => isPlayable(track, onDemand.canRequest))
  const fetching = (onDemand.albumFetch(album.id)?.running ?? 0) > 0
  // The rest of an album you have part of can be fetched too, from the menu.
  const fetchable = onDemand.canRequest && !fetching && tracks.some(track => track.availability === 'on_demand')
  const getAlbum = () => void onDemand.getAlbum(album).then(() => toast({ title: 'Getting this album', description: 'Songs light up as they arrive.' }), () => {})
  const owned = album.availability === 'full' || album.availability === 'partial'

  const want = () => {
    library.setWanted({ type: 'album', album }, !wanted)
    toast({ title: wanted ? 'Removed from Wantlist' : 'Added to Wantlist', description: album.title })
  }
  const enqueue = (placement: 'next' | 'last') => {
    controls.enqueue(playable, placement)
    toast({ title: placement === 'next' ? 'Playing next' : 'Added to queue', description: album.title })
  }

  return (
    <div className="mx-auto max-w-[94rem]">
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
          availabilityNote[album.availability]?.(album, onDemand.canRequest),
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
                ...(fetchable ? [{ label: 'Get this album', icon: <CloudDownload />, onSelect: getAlbum }] : []),
                { kind: 'separator' },
                ...album.artists.map(artist => ({ label: `Go to ${artist.name}`, icon: <MicVocal />, onSelect: () => navigate(`/artist/${artist.id}`) })),
                ...(user.role === 'admin' && owned ? [{ kind: 'separator' }, { label: 'Fix match…', icon: <Wand2 />, onSelect: () => setFixing(true) }] satisfies MenuEntry[] : []),
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
        {album.availability === 'on_demand' && !onDemand.canRequest && (
          <div className="mb-6 flex flex-col gap-3 rounded-2xl bg-surface p-4 sm:flex-row sm:items-center">
            <Disc3 aria-hidden className="size-6 shrink-0 text-quiet" />
            <p className="flex-1 text-sm text-muted">{REQUEST_NOT_ALLOWED} {wanted ? 'It is on your Wantlist.' : 'You can add it to your Wantlist.'}</p>
          </div>
        )}
        {(fetching || (album.availability === 'on_demand' && onDemand.canRequest)) && (
          <div className="mb-6 flex flex-col gap-3 rounded-2xl bg-selection p-4 text-sm text-foreground sm:flex-row sm:items-center">
            <CloudDownload aria-hidden className="size-5 shrink-0 text-accent" />
            {fetching ? (
              <div className="flex flex-1 flex-col gap-2">
                <p className="flex justify-between gap-3 font-medium">
                  <span>Getting this album…</span>
                  <span className="tabular text-muted">{album.ownedTrackCount} of {plural(album.trackCount, 'song')} here</span>
                </p>
                <ProgressBar value={album.trackCount ? album.ownedTrackCount / album.trackCount : null} label={`Getting ${album.title}`} />
              </div>
            ) : (
              <>
                <p className="flex-1">Not on the server yet. Press play to fetch songs as they play, or get the whole album now.</p>
                <Button variant="primary" size="sm" onClick={getAlbum}><CloudDownload />Get this album</Button>
              </>
            )}
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
