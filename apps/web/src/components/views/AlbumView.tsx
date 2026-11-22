import type { AlbumDetail } from '@squirmy/contracts'
import { CloudDownload, Disc3, ListEnd, ListMusic, ListPlus, ListStart, MicVocal, MoreHorizontal, Plus, Wand2 } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
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
import { usePlayerControls } from '@/player/player-context'
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
  const controls = usePlayerControls()
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
            onWant={album.availability === 'full' || !library.wantlistEnabled ? undefined : want}
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

      <div className="px-(--gutter) pb-10">
        {album.availability === 'none' && (
          <Notice icon={<Disc3 />}>
            <p className="flex-1 text-muted-foreground">
              This album is not in your library yet.{library.wantlistEnabled && (wanted ? ' It is on your Wantlist and will fill in when a matching import arrives.' : ' Add it to your Wantlist and a matching import will complete it.')}
            </p>
          </Notice>
        )}
        {album.availability === 'on_demand' && !onDemand.canRequest && (
          <Notice icon={<Disc3 />}>
            <p className="flex-1 text-muted-foreground">{REQUEST_NOT_ALLOWED}{library.wantlistEnabled && (wanted ? ' It is on your Wantlist.' : ' You can add it to your Wantlist.')}</p>
          </Notice>
        )}
        {(fetching || (album.availability === 'on_demand' && onDemand.canRequest)) && (
          <Notice icon={<CloudDownload className="text-primary" />}>
            {fetching ? (
              <div className="flex flex-1 flex-col gap-2">
                <p className="flex justify-between gap-3 font-medium">
                  <span>Getting this album…</span>
                  <span className="font-normal tabular text-muted-foreground">{album.ownedTrackCount} of {plural(album.trackCount, 'song')} here</span>
                </p>
                <ProgressBar value={album.trackCount ? album.ownedTrackCount / album.trackCount : null} label={`Getting ${album.title}`} />
              </div>
            ) : (
              <>
                <p className="flex-1">Not on the server yet. Press play to fetch songs as they play, or get the whole album now.</p>
                <Button variant="primary" size="sm" onClick={getAlbum}><CloudDownload />Get this album</Button>
              </>
            )}
          </Notice>
        )}

        <div className="-mx-2"><TrackList label={`${album.title} tracks`} tracks={tracks} discs={album.discs} variant="album" {...actions} /></div>

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

/** A note above the tracks about what the library has of this album. */
function Notice({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-5 flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm sm:flex-row sm:items-center">
      <span aria-hidden className="shrink-0 text-muted-foreground [&_svg]:size-5">{icon}</span>
      {children}
    </div>
  )
}
