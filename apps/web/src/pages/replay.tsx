import { Id, ReplayPeriod, queryKeys, type TrackSummary } from '@squirmy/contracts'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { useApi } from '@/api/services'
import { Page, PageHeader } from '@/components/layout/Page'
import { Cover } from '@/components/music/Cover'
import { TrackList } from '@/components/music/TrackList'
import { HistoryTransfer } from '@/components/replay/HistoryTransfer'
import { ReplayView } from '@/components/replay/ReplayView'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/feedback'
import { QueryState } from '@/components/ui/query-state'
import { usePageTitle } from '@/lib/document-title'
import { useTrackActions } from '@/player/use-track-actions'
import { NotFoundPage } from './music'

const labels: Record<ReplayPeriod, string> = {
  week: 'This week', month: 'This month', year: 'This year', all: 'All time', review: 'Year in Review',
}

export function ReplayPage() {
  usePageTitle('Replay')
  const [params, setParams] = useSearchParams()
  const api = useApi()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const [currentYear] = useState(() => new Date().getFullYear())
  const period = ReplayPeriod.safeParse(params.get('period')).data ?? 'month'
  const rawYear = Number(params.get('year'))
  const year = Number.isInteger(rawYear) && rawYear >= 1900 && rawYear <= currentYear ? rawYear : currentYear
  const filters = { period, tz, year: period === 'review' ? year : undefined }
  const query = useQuery({ queryKey: [...queryKeys.replay(), filters], queryFn: () => api.userdata.replay(filters), meta: { silent: true } })
  const firstYear = Math.max(1900, Math.min(year, query.data?.firstYear ?? currentYear - 9))
  return <>
    <PageHeader title="Replay" />
    <Page className="flex max-w-7xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-3xl font-semibold tracking-tight">Replay</h2>
        <a className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring" href="#listening-history">Import or export history</a>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Listening period" className="flex flex-wrap gap-1">
          {ReplayPeriod.options.map(option => <Button key={option} variant={period === option ? 'secondary' : 'ghost'} size="sm" aria-pressed={period === option}
            onClick={() => setParams(option === 'review' ? { period: option, year: String(year) } : { period: option })}>{labels[option]}</Button>)}
        </div>
        {period === 'review' && <select value={year} aria-label="Review year"
          className="h-8 rounded-md border bg-background px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring"
          onChange={event => setParams({ period, year: event.target.value })}>
          {Array.from({ length: currentYear - firstYear + 1 }, (_, index) => currentYear - index).map(option => <option key={option}>{option}</option>)}
        </select>}
      </div>
      <QueryState query={query} errorTitle="Replay did not load" loading={<div role="status" aria-label="Loading Replay" className="space-y-5"><Skeleton className="h-56 rounded-2xl" /><Skeleton className="h-48 rounded-xl" /></div>}>
        {stats => <ReplayView stats={stats} tz={tz} reviewYear={period === 'review' ? year : undefined} />}
      </QueryState>
      <div id="listening-history" className="scroll-mt-16"><HistoryTransfer /></div>
    </Page>
  </>
}

export function ReplayTrackPage() {
  const { id: value } = useParams()
  const [params] = useSearchParams()
  const api = useApi()
  const id = Id.safeParse(value).data
  const albumId = Id.safeParse(params.get('album')).data
  const query = useQuery({
    queryKey: [...queryKeys.track(id ?? ''), { albumId }],
    queryFn: () => api.catalog.track(id!, { albumId }),
    enabled: Boolean(id),
    meta: { silent: true },
  })
  usePageTitle(query.data?.title ?? 'Track')
  if (!id) return <NotFoundPage />
  return <>
    <PageHeader title="Track" />
    <Page className="max-w-3xl">
      <QueryState query={query} errorTitle="Track did not load" loading={<Skeleton className="h-48 rounded-xl" />}>
        {track => <TrackDetails track={track} />}
      </QueryState>
    </Page>
  </>
}

function TrackDetails({ track }: { track: TrackSummary }) {
  const actions = useTrackActions([track])
  return <section className="rounded-xl border bg-card p-5">
    <div className="mb-4 flex items-center gap-4">
      <Cover artwork={track.album?.artwork ?? null} className="size-16 shrink-0 sm:size-24" />
      <h2 className="text-2xl font-semibold tracking-tight">{track.title}</h2>
    </div>
    <TrackList label={track.title} tracks={[track]} header={false} {...actions} />
  </section>
}
