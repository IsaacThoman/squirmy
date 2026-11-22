import type { MatchReview, MatchReviewDetail, MatchReviewStatus, ResolveReviewRequest } from '@squirmy/contracts'
import { ArrowLeft, Check, ChevronRight, FolderOpen, ListChecks, Search } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge, EmptyState, Skeleton } from '@/components/ui/feedback'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatRelative, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader } from './AdminLayout'
import { CandidateComparison, CandidatePicker, ScoreMeter } from './MatchCompare'

type ReviewAdminProps = {
  status: MatchReviewStatus
  onStatusChange: (status: MatchReviewStatus) => void
  /** Undefined while loading. */
  reviews: MatchReview[] | undefined
  rootNames: Record<string, string>
  selectedId: string | null
  onSelect: (reviewId: string | null) => void
  /** The selected review in full; undefined while it loads. */
  detail: MatchReviewDetail | undefined
  onResolve: (review: MatchReview, request: ResolveReviewRequest) => Promise<unknown>
  /** Opens Fix match for the review's album, to search MusicBrainz by hand. */
  onSearch: (albumId: string) => void
}

const statusTabs: { value: MatchReviewStatus; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
]

/** "Radiohead – OK Computer (1997)", or what is known of it. */
function taggedAs(summary: MatchReview['summary']): string {
  const album = summary.album ?? 'No album tag'
  return `${summary.artist ? `${summary.artist} – ` : ''}${album}${summary.year ? ` (${summary.year})` : ''}`
}

export function ReviewAdmin({ status, onStatusChange, reviews, rootNames, selectedId, onSelect, detail, onResolve, onSearch }: ReviewAdminProps) {
  const selected = reviews?.find(review => review.id === selectedId) ?? (detail?.id === selectedId ? detail : undefined)
  return (
    <div>
      <AdminHeader title="Review queue" description="Albums the matcher was not sure about. Compare the files with each candidate; whatever you choose is locked, and rescans never change it." />
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        <div className={cn('flex flex-col gap-4 xl:sticky xl:top-20 xl:w-80 xl:shrink-0', selectedId && 'max-xl:hidden')}>
          <Tabs value={status} onValueChange={value => onStatusChange(value as MatchReviewStatus)}>
            <TabsList aria-label="Show reviews">
              {statusTabs.map(tab => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          {!reviews && <div className="flex flex-col gap-2">{[0, 1, 2].map(index => <Skeleton key={index} className="h-[74px] rounded-2xl" />)}</div>}
          {reviews?.length === 0 && (
            <EmptyState
              className="rounded-2xl bg-sheet py-10 ring-1 ring-stroke"
              icon={<ListChecks />}
              title={status === 'open' ? 'Nothing to review' : `No ${status} reviews`}
              description={status === 'open' ? 'Every album is identified or playing from its tags.' : undefined}
            />
          )}
          {reviews && reviews.length > 0 && (
            <ul aria-label="Reviews" className="flex flex-col gap-1 rounded-2xl bg-sheet p-1.5 ring-1 ring-stroke">
              {reviews.map(review => (
                <li key={review.id}>
                  <button
                    type="button"
                    aria-current={review.id === selectedId || undefined}
                    onClick={() => onSelect(review.id)}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-overlay aria-[current]:bg-selection"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold" title={taggedAs(review.summary)}>{taggedAs(review.summary)}</span>
                      <span className="block truncate font-mono text-xs text-muted">{rootNames[review.rootId] ?? 'Folder'}/{review.summary.folder}</span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-quiet">
                        {plural(review.summary.trackCount, 'file')} · {review.candidateCount ? plural(review.candidateCount, 'candidate') : 'no candidates'}
                      </span>
                    </span>
                    {review.bestScore !== null ? <ScoreMeter score={review.bestScore} className="w-20" /> : <Badge tone="outline">None</Badge>}
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-quiet xl:hidden" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={cn('min-w-0 flex-1', !selectedId && 'max-xl:hidden')}>
          {selectedId && (
            <Button variant="ghost" size="sm" className="-ml-2 mb-3 xl:hidden" onClick={() => onSelect(null)}><ArrowLeft />All reviews</Button>
          )}
          {!selectedId && reviews && reviews.length > 0 && (
            <EmptyState className="rounded-2xl bg-sheet ring-1 ring-stroke" icon={<ListChecks />} title="Pick an album" description="Its files and the releases MusicBrainz offered appear here side by side." />
          )}
          {selectedId && !detail && <Skeleton className="h-[480px] rounded-2xl" />}
          {selectedId && detail && selected && (
            <ReviewDetail key={detail.id} review={detail} rootName={rootNames[detail.rootId]} onResolve={request => onResolve(selected, request)} onSearch={onSearch} />
          )}
        </div>
      </div>
    </div>
  )
}

type Pending = 'release' | 'keep_local' | 'dismiss' | null

function ReviewDetail({ review, rootName, onResolve, onSearch }: { review: MatchReviewDetail; rootName: string | undefined; onResolve: (request: ResolveReviewRequest) => Promise<unknown>; onSearch: (albumId: string) => void }) {
  const [chosen, setChosen] = useState(review.candidates[0]?.releaseMbid ?? null)
  const [pending, setPending] = useState<Pending>(null)
  const candidate = review.candidates.find(item => item.releaseMbid === chosen)
  const open = review.status === 'open'
  const resolve = async (kind: Exclude<Pending, null>, request: ResolveReviewRequest) => {
    setPending(kind)
    try {
      await onResolve(request)
    } catch {
      // The failure is a toast; the review stays so it can be tried again.
    } finally {
      setPending(null)
    }
  }
  return (
    <article aria-label={`Review of ${taggedAs(review.summary)}`} className="flex flex-col gap-6">
      <div className="rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
        <p className="text-xs font-semibold text-muted">The tags say</p>
        <h3 className="mt-0.5 text-xl font-bold tracking-tight">{taggedAs(review.summary)}</h3>
        <p className="mt-1.5 flex items-center gap-1.5 text-[13px] text-muted">
          <FolderOpen aria-hidden className="size-4 shrink-0 text-quiet" />
          <span className="truncate font-mono">{rootName ?? 'Folder'}/{review.summary.folder}</span>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-quiet">
          <Badge tone={open ? 'accent' : 'neutral'}>{review.status}</Badge>
          <span>{plural(review.files.length, 'file')} · queued {formatRelative(review.createdAt)}{review.resolvedAt && ` · closed ${formatRelative(review.resolvedAt)}`}</span>
        </div>
      </div>

      {review.candidates.length > 1 && <CandidatePicker name={`review-${review.id}`} candidates={review.candidates} selected={chosen} onSelect={setChosen} />}
      {candidate
        ? <CandidateComparison candidate={candidate} files={review.files} />
        : (
          <EmptyState
            className="rounded-2xl bg-sheet ring-1 ring-stroke"
            icon={<Search />}
            title="MusicBrainz offered nothing close"
            description="Search it yourself with a different spelling, a release link or its MBID, or keep the album as its tags describe it."
            action={review.albumId && <Button onClick={() => onSearch(review.albumId!)}><Search />Search MusicBrainz</Button>}
          />
        )}

      <div className="z-10 flex flex-col gap-3 rounded-2xl bg-sheet p-3 ring-1 ring-stroke md:sticky md:bottom-4 md:bg-floating md:shadow-float md:ring-0 md:backdrop-blur-xl">
        <p className="px-1 text-xs leading-relaxed text-muted">
          {open
            ? 'Use this release to take its titles and artwork. Keep as it is plays the album from its tags and stops asking. Dismiss closes the review for now.'
            : `This review is ${review.status}. You can still change the album with Fix match.`}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {open ? (
            <>
              {candidate && review.albumId && <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => onSearch(review.albumId!)}><Search />Search</Button>}
              <Button size="sm" variant="ghost" disabled={!!pending} pending={pending === 'dismiss'} onClick={() => void resolve('dismiss', { action: 'dismiss' })}>Dismiss</Button>
              <Button size="sm" variant="outline" disabled={!!pending} pending={pending === 'keep_local'} onClick={() => void resolve('keep_local', { action: 'keep_local' })}>Keep as it is</Button>
              {candidate && <Button size="sm" variant="primary" disabled={!!pending} pending={pending === 'release'} onClick={() => void resolve('release', { releaseMbid: candidate.releaseMbid })}><Check />Use this release</Button>}
            </>
          ) : review.albumId && <Button size="sm" onClick={() => onSearch(review.albumId!)}><Search />Fix match</Button>}
        </div>
      </div>
    </article>
  )
}
