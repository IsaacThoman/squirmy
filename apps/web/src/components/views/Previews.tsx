import type { AlbumSummary, ArtistSummary } from '@squirmy/contracts'
import { ArtistLinks } from '@/components/music/ArtistLinks'
import { CollectionHeader, PlayActions } from '@/components/music/CollectionHeader'
import { Cover } from '@/components/music/Cover'
import { RailSkeleton, TrackRowsSkeleton } from '@/components/music/Skeletons'
import { albumTypeLabel } from '@/lib/catalog'
import { plural } from '@/lib/format'
import { ArtistHeader } from './ArtistView'

/**
 * Album and artist pages drawn from the summary a list already had, while their detail
 * loads: the header is the real one, the rest is a skeleton. When the detail arrives the
 * page is complete without anything above the songs moving.
 */

export function AlbumPreview({ album }: { album: AlbumSummary }) {
  return (
    <div role="status" aria-label={`Loading ${album.title}`}>
      <CollectionHeader
        kind={albumTypeLabel(album.type)}
        title={album.title}
        tint={album.artwork?.color}
        art={<Cover artwork={album.artwork} size={600} alt={`${album.title} cover`} dimmed={album.availability === 'none'} />}
        byline={<ArtistLinks credit={album} />}
        // A summary that knows no songs yet often has them on the page itself: "0 songs" would be wrong a moment later.
        meta={[album.year ? String(album.year) : null, album.trackCount > 0 && plural(album.trackCount, 'song')]}
        actions={<PlayActions title={album.title} />}
      />
      <div className="px-(--gutter) pb-10"><TrackRowsSkeleton rows={Math.min(Math.max(album.trackCount, 4), 12)} /></div>
    </div>
  )
}

export function ArtistPreview({ artist }: { artist: ArtistSummary }) {
  return (
    <div role="status" aria-label={`Loading ${artist.name}`}>
      <ArtistHeader artist={artist} actions={<PlayActions title={artist.name} />} />
      <div className="flex flex-col gap-10 px-(--gutter) pb-10">
        <TrackRowsSkeleton rows={5} art />
        <RailSkeleton />
      </div>
    </div>
  )
}
