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
import { cardClass } from './Panel'

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
  // With nothing listed and nothing open there is no second pane, so the list takes the page.
  const alone = reviews?.length === 0 && !selectedId
  return (
    <div className="@container">
      <AdminHeader title="Review queue" description="Albums the matcher was not sure about. Compare the files with each candidate; whatever you choose is locked, and rescans never change it." />
      {/* Side by side when there is room; otherwise the list, then the album picked from it. */}
      <div className="flex flex-col gap-6 @4xl:flex-row @4xl:items-start">
        <div className={cn('flex min-w-0 flex-col gap-3', alone ? 'flex-1' : '@4xl:sticky @4xl:top-18 @4xl:w-80 @4xl:shrink-0', selectedId && '@max-4xl:hidden')}>
          <Tabs value={status} onValueChange={value => onStatusChange(value as MatchReviewStatus)}>
            <TabsList aria-label="Show reviews">
              {statusTabs.map(tab => <TabsTrigger key={tab.value} value={tab.value}>{tab.label}</TabsTrigger>)}
            </TabsList>
          </Tabs>
          {!reviews && (
            <div className={cn(cardClass, 'flex flex-col gap-0.5 p-1')}>
              {[0, 1, 2].map(index => (
                <div key={index} className="flex flex-col gap-2 px-3 py-2.5"><Skeleton className="h-4 w-48 max-w-full" /><Skeleton className="h-3 w-32" /></div>
              ))}
            </div>
          )}
          {reviews?.length === 0 && (
            <EmptyState
              className={cn(cardClass, 'py-10')}
              icon={<ListChecks />}
              title={status === 'open' ? 'Nothing to review' : `No ${status} reviews`}
              description={status === 'open' ? 'Every album is identified or playing from its tags.' : undefined}
            />
          )}
          {reviews && reviews.length > 0 && (
            <ul aria-label="Reviews" className={cn(cardClass, 'flex flex-col gap-0.5 p-1')}>
              {reviews.map(review => (
                <li key={review.id}>
                  <button
                    type="button"
                    aria-current={review.id === selectedId || undefined}
                    onClick={() => onSelect(review.id)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current]:bg-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" title={taggedAs(review.summary)}>{taggedAs(review.summary)}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">{rootNames[review.rootId] ?? 'Folder'}/{review.summary.folder}</span>
                      <span className="mt-1 flex items-center justify-between gap-3 text-xs tabular text-muted-foreground">
                        <span className="truncate">{plural(review.summary.trackCount, 'file')} · {review.candidateCount ? plural(review.candidateCount, 'candidate') : 'no candidates'}</span>
                        {review.bestScore !== null ? <ScoreMeter score={review.bestScore} className="w-20" /> : <Badge tone="outline">None</Badge>}
                      </span>
                    </span>
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground @4xl:hidden" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={cn('min-w-0 flex-1', !selectedId && '@max-4xl:hidden', alone && 'hidden')}>
          {selectedId && (
            <Button variant="ghost" size="sm" className="-ml-2.5 mb-3 @4xl:hidden" onClick={() => onSelect(null)}><ArrowLeft />All reviews</Button>
          )}
          {!selectedId && reviews && reviews.length > 0 && (
            <EmptyState className={cardClass} icon={<ListChecks />} title="Pick an album" description="Its files and the releases MusicBrainz offered appear here side by side." />
          )}
          {selectedId && !detail && <Skeleton className="h-96 rounded-xl" />}
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
    <article aria-label={`Review of ${taggedAs(review.summary)}`} className="flex flex-col gap-5">
      <div className={cn(cardClass, 'p-4')}>
        <p className="text-xs text-muted-foreground">The tags say</p>
        <h3 className="mt-0.5 text-base font-semibold text-balance">{taggedAs(review.summary)}</h3>
        <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <FolderOpen aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{rootName ?? 'Folder'}/{review.summary.folder}</span>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge tone={open ? 'accent' : 'neutral'} className="capitalize">{review.status}</Badge>
          <span className="tabular">{plural(review.files.length, 'file')} · queued {formatRelative(review.createdAt)}{review.resolvedAt && ` · closed ${formatRelative(review.resolvedAt)}`}</span>
        </div>
      </div>

      {review.candidates.length > 1 && <CandidatePicker name={`review-${review.id}`} candidates={review.candidates} selected={chosen} onSelect={setChosen} />}
      {candidate
        ? <CandidateComparison candidate={candidate} files={review.files} />
        : (
          <EmptyState
            className={cardClass}
            icon={<Search />}
            title="MusicBrainz offered nothing close"
            description="Search it yourself with a different spelling, a release link or its MBID, or keep the album as its tags describe it."
            action={review.albumId && <Button onClick={() => onSearch(review.albumId!)}><Search />Search MusicBrainz</Button>}
          />
        )}

      {/* The decision stays in reach under a long track list. */}
      <div className="z-10 flex flex-col gap-3 border-t bg-background/85 py-3 backdrop-blur-md md:sticky md:bottom-0 lg:flex-row lg:items-center lg:gap-6">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {open
            ? 'Use this release to take its titles and artwork. Keep as it is plays the album from its tags and stops asking. Dismiss closes the review for now.'
            : `This review is ${review.status}. You can still change the album with Fix match.`}
        </p>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 max-sm:*:grow">
          {open ? (
            <>
              {candidate && review.albumId && <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => onSearch(review.albumId!)}><Search />Search</Button>}
              <Button size="sm" variant="ghost" disabled={!!pending} pending={pending === 'dismiss'} onClick={() => void resolve('dismiss', { action: 'dismiss' })}>Dismiss</Button>
              <Button size="sm" variant="outline" disabled={!!pending} pending={pending === 'keep_local'} onClick={() => void resolve('keep_local', { action: 'keep_local' })}>Keep as it is</Button>
              {candidate && <Button size="sm" variant="primary" disabled={!!pending} pending={pending === 'release'} onClick={() => void resolve('release', { releaseMbid: candidate.releaseMbid })}><Check />Use this release</Button>}
            </>
          ) : review.albumId && <Button size="sm" variant="outline" onClick={() => onSearch(review.albumId!)}><Search />Fix match</Button>}
        </div>
      </div>
    </article>
  )
}
