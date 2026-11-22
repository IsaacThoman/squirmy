import type { AlbumSummary, TrackSummary } from '@squirmy/contracts'
import { Bookmark } from 'lucide-react'
import { Page, PageHeader } from '@/components/layout/Page'
import { AlbumCard, CardGrid } from '@/components/music/Cards'
import { SectionHeader } from '@/components/music/SectionHeader'
import { GridSkeleton } from '@/components/music/Skeletons'
import { TrackList } from '@/components/music/TrackList'
import { EmptyState } from '@/components/ui/feedback'
import { plural } from '@/lib/format'
import { useAlbumWants, useTrackActions } from '@/player/use-track-actions'

/** Music you want but do not have. A matching import completes it. Undefined while loading. */
export function WantlistView({ albums, tracks }: { albums: AlbumSummary[] | undefined; tracks: TrackSummary[] | undefined }) {
  const actions = useTrackActions(tracks ?? [])
  const wants = useAlbumWants()
  const count = albums && tracks ? albums.length + tracks.length : 0
  return (
    <>
      <PageHeader title="Wantlist">
        {count > 0 && <span className="text-xs tabular text-muted-foreground">{plural(count, 'item')}</span>}
      </PageHeader>
      <Page className="flex flex-col gap-8">
        <p className="max-w-xl text-pretty text-sm text-muted-foreground">Albums and songs you’ve asked for. They light up here as soon as a matching import lands in your library.</p>
        {(!albums || !tracks) && <GridSkeleton count={6} />}
        {albums && tracks && count === 0 && (
          <EmptyState icon={<Bookmark />} title="Nothing wanted yet" description="Gray albums and songs in search and on artist pages can be added to your Wantlist." />
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
    </>
  )
}
