import type { AlbumSummary, TrackSummary } from '@squirmy/contracts'
import { Bookmark, Search } from 'lucide-react'
import { Link } from 'react-router'
import { Page } from '@/components/layout/Page'
import { AlbumCard, CardGrid } from '@/components/music/Cards'
import { PageTitle, SectionHeader } from '@/components/music/SectionHeader'
import { GridSkeleton } from '@/components/music/Skeletons'
import { TrackList } from '@/components/music/TrackList'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'

/** Music you want but do not have. A matching import completes it. Undefined while loading. */
export function WantlistView({ albums, tracks }: { albums: AlbumSummary[] | undefined; tracks: TrackSummary[] | undefined }) {
  const actions = useTrackActions(tracks ?? [])
  const wants = useAlbumWants()
  return (
    <Page className="mx-auto flex max-w-[94rem] flex-col gap-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle>Wantlist</PageTitle>
        <Button asChild variant="outline" size="sm"><Link to="/search"><Search />Find music</Link></Button>
      </header>
      {(!albums || !tracks) && <GridSkeleton count={6} />}
      {albums && tracks && albums.length + tracks.length === 0 && (
        <EmptyState icon={<Bookmark />} title="Your Wantlist is empty" description="Save albums and songs from search or artist pages to track music you still want to add." />
      )}
      {albums && albums.length > 0 && (
        <section>
          <SectionHeader title="Albums" />
          <CardGrid>{albums.map(album => <AlbumCard key={album.id} album={album} {...wants(album)} />)}</CardGrid>
        </section>
      )}
      {tracks && tracks.length > 0 && (
        <section>
          <SectionHeader title="Songs" />
          <TrackList label="Wanted songs" tracks={tracks} variant="compact" header={false} {...actions} />
        </section>
      )}
    </Page>
  )
}
