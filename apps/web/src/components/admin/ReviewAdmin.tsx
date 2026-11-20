import type { AlbumSummary } from '@squirmy/contracts'
import { ArrowRight, Check, FolderTree, ListChecks, Search, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { Cover } from '@/components/music/Cover'
import { Button } from '@/components/ui/button'
import { Badge, EmptyState } from '@/components/ui/feedback'
import { SearchField } from '@/components/ui/search-field'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader } from './AdminLayout'

/** The matching contracts are not written yet; this is the shape the review queue expects. */
export type ReviewItem = {
  id: string
  folder: string
  fileCount: number
  /** What the files' tags produced, if anything. */
  album: AlbumSummary | null
  candidates: { title: string; artist: string; year: number; tracks: number; country: string; score: number }[]
}

type ReviewAdminProps = {
  reviews: ReviewItem[]
  onAccept: (reviewId: string, candidate: number) => void
  onSkip: (reviewId: string) => void
}

export function ReviewAdmin({ reviews, onAccept, onSkip }: ReviewAdminProps) {
  return (
    <div>
      <AdminHeader title="Review queue" description="Albums the matcher was not sure about. Pick the right release and the match is locked; rescans never change it." />
      {reviews.length === 0 && <EmptyState icon={<ListChecks />} title="Nothing to review" description="Every album in the library is identified or playing from its tags." />}
      <ul className="flex flex-col gap-4">
        {reviews.map(review => <ReviewCard key={review.id} review={review} onAccept={onAccept} onSkip={onSkip} />)}
      </ul>
    </div>
  )
}

function ReviewCard({ review, onAccept, onSkip }: { review: ReviewItem } & Omit<ReviewAdminProps, 'reviews'>) {
  const [chosen, setChosen] = useState(0)
  const [query, setQuery] = useState('')
  return (
    <li className="overflow-hidden rounded-2xl bg-sheet ring-1 ring-stroke">
      <div className="flex items-center gap-4 border-b border-stroke p-4">
        <Cover artwork={review.album?.artwork ?? null} size={96} className="size-14 rounded-lg" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold">{review.album ? `${review.album.title} · ${review.album.artistCredit}` : 'Untagged files'}</h3>
          <p className="truncate font-mono text-xs text-muted">{review.folder}</p>
        </div>
        <Badge>{plural(review.fileCount, 'file')}</Badge>
      </div>
      {review.candidates.length ? (
        <fieldset className="p-2">
          <legend className="sr-only">Candidate releases</legend>
          {review.candidates.map((candidate, index) => (
            <label key={index} className={cn('flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-overlay', chosen === index && 'bg-selection hover:bg-selection')}>
              <input type="radio" name={`review-${review.id}`} checked={chosen === index} onChange={() => setChosen(index)} className="size-4 accent-(--accent)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{candidate.title}</span>
                <span className="block truncate text-xs text-muted">{candidate.artist} · {candidate.year} · {candidate.country} · {plural(candidate.tracks, 'track')}</span>
              </span>
              <span className="flex w-28 items-center gap-2">
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-stroke"><span className="block h-full rounded-full bg-accent" style={{ width: `${candidate.score * 100}%` }} /></span>
                <span className="w-8 text-right text-xs font-semibold tabular text-muted">{Math.round(candidate.score * 100)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <div className="flex flex-col gap-3 p-4">
          <p className="text-sm text-muted">No candidates found. Search MusicBrainz by artist and album.</p>
          <SearchField value={query} onValueChange={setQuery} placeholder="Artist – album" className="max-w-md" />
        </div>
      )}
      <div className="flex justify-end gap-2 border-t border-stroke p-3">
        <Button size="sm" variant="ghost" onClick={() => onSkip(review.id)}>Leave unmatched</Button>
        {review.candidates.length
          ? <Button size="sm" variant="primary" onClick={() => onAccept(review.id, chosen)}><Check />Use this release</Button>
          : <Button size="sm" variant="primary" disabled={!query.trim()}><Search />Search</Button>}
      </div>
    </li>
  )
}

/** The organize contracts are not written yet; a proposed move is a path pair relative to the root. */
export type OrganizeMove = { from: string; to: string }

type OrganizeAdminProps = {
  template: string
  moves: OrganizeMove[]
  onApply: () => void
  onUndo: () => void
}

export function OrganizeAdmin({ template, moves, onApply, onUndo }: OrganizeAdminProps) {
  return (
    <div>
      <AdminHeader title="Organize" description="What filing the managed folders would change. Nothing moves until you apply it, and every batch can be undone.">
        <Button onClick={onUndo}><Undo2 />Undo last batch</Button>
        <Button variant="primary" disabled={!moves.length} onClick={onApply}>Apply {moves.length ? plural(moves.length, 'move') : ''}</Button>
      </AdminHeader>
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-sheet px-4 py-3 ring-1 ring-stroke">
        <FolderTree aria-hidden className="size-4 text-quiet" />
        <span className="text-sm text-muted">Template</span>
        <code className="rounded-md bg-surface px-2 py-0.5 font-mono text-[13px]">{template}</code>
      </div>
      {moves.length === 0
        ? <EmptyState icon={<FolderTree />} title="Everything is in its place" />
        : (
          <ul className="divide-y divide-stroke overflow-hidden rounded-2xl bg-sheet ring-1 ring-stroke">
            {moves.map(move => (
              <li key={move.from} className="grid gap-1 px-4 py-3 font-mono text-[13px] md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-3">
                <span className="truncate text-muted line-through decoration-stroke">{move.from}</span>
                <ArrowRight aria-label="moves to" className="size-4 text-accent max-md:hidden" />
                <span className="truncate">{move.to}</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}
