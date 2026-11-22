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
    <Page className="flex flex-col gap-10">
      <div>
        <PageTitle>Wantlist</PageTitle>
        <p className="mt-2 max-w-xl text-[15px] text-muted">Albums and songs you’ve asked for. They light up here as soon as a matching import lands in your library.</p>
      </div>
      {(!albums || !tracks) && <GridSkeleton count={6} />}
      {albums && tracks && albums.length + tracks.length === 0 && (
        <div className="rounded-xl border border-stroke bg-sheet">
          <EmptyState
            icon={<Bookmark />}
            title="Nothing wanted yet"
            description="Save albums and songs you don’t have from search or an artist page."
            action={<Button asChild variant="outline"><Link to="/search"><Search />Search music</Link></Button>}
          />
        </div>
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
          <div className="-mx-2"><TrackList label="Wanted songs" tracks={tracks} variant="compact" header={false} {...actions} /></div>
        </section>
      )}
    </Page>
  )
}
