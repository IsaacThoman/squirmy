import type { MatchCandidate, MatchFile, MatchScoreBreakdown } from '@squirmy/contracts'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { formatDuration, plural } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Durations further apart than this are shown as a difference. */
const DURATION_TOLERANCE_MS = 3000

const sameText = (a: string | null, b: string) => {
  const key = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  return a !== null && key(a) === key(b)
}

const percent = (value: number) => `${Math.round(value * 100)}`

/** A score from 0 to 1 as a short bar and its percentage. */
export function ScoreMeter({ score, className }: { score: number; className?: string }) {
  return (
    <span className={cn('flex w-24 shrink-0 items-center gap-2', className)} title={`Score ${percent(score)} of 100`}>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-stroke"><span className="block h-full rounded-full bg-accent" style={{ width: `${score * 100}%` }} /></span>
      <span className="w-7 text-right text-xs font-bold tabular text-muted">{percent(score)}</span>
    </span>
  )
}

/** "1997-05-21 · JP · CD · EMI" */
function releaseLine(candidate: MatchCandidate): string {
  return [candidate.date, candidate.country, candidate.format, candidate.label].filter(Boolean).join(' · ')
}

/** The candidates as a choice; the chosen one is compared below it. */
export function CandidatePicker({ candidates, selected, onSelect, name }: { candidates: MatchCandidate[]; selected: string | null; onSelect: (releaseMbid: string) => void; name: string }) {
  return (
    <fieldset className="flex flex-col gap-1 rounded-2xl bg-sheet p-1.5 ring-1 ring-stroke">
      <legend className="sr-only">Candidate releases</legend>
      {candidates.map(candidate => (
        <label key={candidate.releaseMbid} className={cn('flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-overlay', selected === candidate.releaseMbid && 'bg-selection hover:bg-selection')}>
          <input type="radio" name={name} checked={selected === candidate.releaseMbid} onChange={() => onSelect(candidate.releaseMbid)} className="size-4 shrink-0 accent-(--accent)" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">
              {candidate.title}{candidate.disambiguation && <span className="font-normal text-muted"> ({candidate.disambiguation})</span>}
            </span>
            <span className="block truncate text-xs text-muted">{[candidate.artistCredit, releaseLine(candidate), plural(candidate.trackCount, 'track')].filter(Boolean).join(' · ')}</span>
          </span>
          <ScoreMeter score={candidate.score} />
        </label>
      ))}
    </fieldset>
  )
}

const parts: { key: keyof MatchScoreBreakdown; label: string; hint: string }[] = [
  { key: 'tracks', label: 'Tracks', hint: 'Titles and durations of the paired tracks' },
  { key: 'files', label: 'Files placed', hint: 'Your files that found a track on the release' },
  { key: 'coverage', label: 'Coverage', hint: 'Tracks of the release you have' },
  { key: 'title', label: 'Album title', hint: 'Against the release and its group' },
  { key: 'artist', label: 'Artist', hint: 'Album artist against the credit' },
  { key: 'year', label: 'Year', hint: 'Tagged year against the release dates' },
]

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex min-h-8 items-center justify-between gap-3 px-1">
        <h4 className="text-[13px] font-bold uppercase tracking-wider text-quiet">{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** One candidate against the files: what the release is, how it scored and track by track. */
export function CandidateComparison({ candidate, files }: { candidate: MatchCandidate; files: MatchFile[] }) {
  const details: [string, string | null][] = [
    ['Released', candidate.date],
    ['Country', candidate.country],
    ['Label', [candidate.label, candidate.catalogNumber].filter(Boolean).join(' · ') || null],
    ['Format', candidate.format],
    ['Tracks', `${candidate.trackCount}${candidate.discCount > 1 ? ` on ${candidate.discCount} discs` : ''}`],
    ['Barcode', candidate.barcode],
    ['Status', candidate.status],
  ]
  return (
    <div className="@container flex flex-col gap-6">
      <div className="grid gap-6 @2xl:grid-cols-2">
        <Section
          title="Release"
          aside={(
            <Button asChild size="sm" variant="ghost" className="-mr-2">
              <a href={`https://musicbrainz.org/release/${candidate.releaseMbid}`} target="_blank" rel="noreferrer">MusicBrainz<ExternalLink /></a>
            </Button>
          )}
        >
          <div className="rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
            <p className="text-[15px] font-bold">{candidate.title}{candidate.disambiguation && <span className="font-normal text-muted"> ({candidate.disambiguation})</span>}</p>
            <p className="text-sm text-muted">{candidate.artistCredit}</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px] @lg:grid-cols-[auto_1fr_auto_1fr] @2xl:grid-cols-[auto_1fr]">
              {details.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-quiet">{label}</dt>
                  <dd className={cn('min-w-0 truncate font-medium first-letter:uppercase', !value && 'text-quiet')}>{value ?? 'Unknown'}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Section>
        <Section title="Score" aside={<span className="text-sm font-bold tabular">{percent(candidate.score)}<span className="font-medium text-quiet"> / 100</span></span>}>
          <ul className="grid grid-cols-2 gap-x-5 gap-y-3 rounded-2xl bg-sheet p-4 ring-1 ring-stroke @lg:grid-cols-3 @2xl:grid-cols-2">
            {parts.map(part => {
              const value = candidate.breakdown[part.key]
              return (
                <li key={part.key} className="flex min-w-0 flex-col gap-1" title={part.hint}>
                  <span className="truncate text-[13px] font-semibold">{part.label}</span>
                  {value === null ? <span className="text-xs text-quiet">Not compared</span> : <ScoreMeter score={value} className="w-full" />}
                </li>
              )
            })}
          </ul>
        </Section>
      </div>
      <Section title="Track by track">
        <TrackComparison candidate={candidate} files={files} />
      </Section>
    </div>
  )
}

function Different({ when, children }: { when: boolean; children: ReactNode }) {
  return when ? <mark className="rounded bg-danger/12 px-1 text-danger">{children}</mark> : <>{children}</>
}

function TrackComparison({ candidate, files }: { candidate: MatchCandidate; files: MatchFile[] }) {
  const byId = new Map(files.map(file => [file.id, file]))
  const extras = candidate.extraFileIds.flatMap(id => byId.get(id) ?? [])
  const multiDisc = candidate.discCount > 1
  const head = 'grid grid-cols-[2.25rem_minmax(0,1fr)_3.5rem] gap-x-3 @lg:grid-cols-[2.25rem_minmax(0,1fr)_minmax(0,1fr)_3.5rem]'
  return (
    <div className="overflow-hidden rounded-2xl bg-sheet ring-1 ring-stroke">
      <div className={cn(head, 'border-b border-stroke px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-quiet')}>
        <span>#</span>
        <span className="@max-lg:hidden">Your files</span>
        <span><span className="@lg:hidden">Your file / </span>On the release</span>
        <span className="text-right">Fit</span>
      </div>
      <ol className="divide-y divide-stroke">
        {candidate.tracks.map(track => {
          const file = track.fileId ? byId.get(track.fileId) : undefined
          const titleDiffers = !!file && !sameText(file.title, track.title)
          const durationDiffers = !!file && track.durationMs !== null && Math.abs(file.durationMs - track.durationMs) > DURATION_TOLERANCE_MS
          return (
            <li key={`${track.disc}-${track.position}`} className={cn(head, 'items-start px-4 py-2.5 text-[13px]')}>
              <span className="pt-px font-semibold tabular text-quiet">{multiDisc ? `${track.disc}.${track.position}` : track.position}</span>
              <span className="flex min-w-0 flex-col @max-lg:col-start-2 @max-lg:row-start-1">
                {file ? (
                  <>
                    <span className="truncate font-medium"><Different when={titleDiffers}>{file.title ?? 'No title'}</Different></span>
                    <span className="truncate text-xs text-quiet"><Different when={durationDiffers}>{formatDuration(file.durationMs)}</Different> · {file.relPath.split('/').pop()}</span>
                  </>
                ) : <span className="italic text-quiet">No file</span>}
              </span>
              <span className="flex min-w-0 flex-col @max-lg:col-start-2 @max-lg:mt-1.5">
                <span className="truncate font-medium">{track.title}</span>
                <span className="text-xs text-quiet">
                  {track.durationMs === null ? 'No length' : <Different when={durationDiffers}>{formatDuration(track.durationMs)}</Different>}
                  {durationDiffers && file && track.durationMs !== null && <span className="text-danger"> · {deltaSeconds(file.durationMs - track.durationMs)}</span>}
                </span>
              </span>
              <span className="pt-px text-right text-xs font-bold tabular text-muted @max-lg:col-start-3 @max-lg:row-start-1">{track.similarity === null ? '–' : percent(track.similarity)}</span>
            </li>
          )
        })}
        {extras.map(file => (
          <li key={file.id} className={cn(head, 'items-start bg-overlay px-4 py-2.5 text-[13px]')}>
            <span className="pt-px font-semibold tabular text-quiet">{file.track ?? '–'}</span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{file.title ?? 'No title'}</span>
              <span className="truncate text-xs text-quiet">{formatDuration(file.durationMs)} · {file.relPath.split('/').pop()}</span>
            </span>
            <span className="text-xs italic text-quiet @max-lg:col-start-2">Not on this release</span>
            <span className="text-right text-xs text-quiet @max-lg:col-start-3 @max-lg:row-start-1">–</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function deltaSeconds(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${seconds > 0 ? '+' : '−'}${formatDuration(Math.abs(seconds) * 1000)} on your file`
}
