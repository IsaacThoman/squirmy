import type { AlbumSummary, TrackSummary } from '@squirmy/contracts'
import { Bookmark } from 'lucide-react'
import { Page } from '@/components/layout/Page'
import { AlbumCard, CardGrid } from '@/components/music/Cards'
import { PageTitle, SectionHeader } from '@/components/music/SectionHeader'
import { TrackList } from '@/components/music/TrackList'
import { EmptyState } from '@/components/ui/feedback'
import { useTrackActions } from '@/player/use-track-actions'

/** Music you want but do not have. A matching import completes it. */
export function WantlistView({ albums, tracks }: { albums: AlbumSummary[]; tracks: TrackSummary[] }) {
  const actions = useTrackActions(tracks)
  return (
    <Page className="flex flex-col gap-10">
      <div>
        <PageTitle>Wantlist</PageTitle>
        <p className="mt-2 max-w-xl text-[15px] text-muted">Albums and songs you’ve asked for. They light up here as soon as a matching import lands in your library.</p>
      </div>
      {albums.length + tracks.length === 0 && (
        <EmptyState icon={<Bookmark />} title="Nothing wanted yet" description="Gray albums and songs in search and on artist pages can be added to your Wantlist." />
      )}
      {albums.length > 0 && (
        <section>
          <SectionHeader title="Albums" />
          <CardGrid>{albums.map(album => <AlbumCard key={album.id} album={album} />)}</CardGrid>
        </section>
      )}
      {tracks.length > 0 && (
        <section>
          <SectionHeader title="Songs" />
          <div className="-mx-2"><TrackList label="Wanted songs" tracks={tracks} variant="compact" header={false} {...actions} isWanted={() => true} /></div>
        </section>
      )}
    </Page>
  )
}
