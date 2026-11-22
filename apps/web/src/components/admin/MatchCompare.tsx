import type { MatchCandidate, MatchFile, MatchScoreBreakdown } from '@squirmy/contracts'
import { ExternalLink } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { formatDuration, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { cardClass } from './Panel'

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
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-primary" style={{ width: `${score * 100}%` }} /></span>
      <span className="w-6 text-right text-xs tabular text-muted-foreground">{percent(score)}</span>
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
    <fieldset className={cn(cardClass, 'flex min-w-0 flex-col gap-0.5 p-1')}>
      <legend className="sr-only">Candidate releases</legend>
      {candidates.map(candidate => (
        <label key={candidate.releaseMbid} className={cn('flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-accent/60', selected === candidate.releaseMbid && 'bg-accent hover:bg-accent')}>
          <input type="radio" name={name} checked={selected === candidate.releaseMbid} onChange={() => onSelect(candidate.releaseMbid)} className="size-4 shrink-0 accent-primary" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium sm:truncate" title={candidate.title}>
              {candidate.title}{candidate.disambiguation && <span className="font-normal text-muted-foreground"> ({candidate.disambiguation})</span>}
            </span>
            <span className="block text-xs text-muted-foreground sm:truncate">{[candidate.artistCredit, releaseLine(candidate), plural(candidate.trackCount, 'track')].filter(Boolean).join(' · ')}</span>
          </span>
          <ScoreMeter score={candidate.score} className="max-sm:w-16" />
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

function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h4 className="text-sm font-semibold">{title}</h4>
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
    <div className="@container flex flex-col gap-5">
      <div className="grid gap-5 @2xl:grid-cols-2">
        <Part
          title="Release"
          aside={(
            <Button asChild size="sm" variant="ghost" className="-mr-2.5 h-7 text-muted-foreground">
              <a href={`https://musicbrainz.org/release/${candidate.releaseMbid}`} target="_blank" rel="noreferrer">MusicBrainz<ExternalLink className="size-3.5" /></a>
            </Button>
          )}
        >
          <div className={cn(cardClass, 'flex-1 p-4')}>
            <p className="text-sm font-medium">{candidate.title}{candidate.disambiguation && <span className="font-normal text-muted-foreground"> ({candidate.disambiguation})</span>}</p>
            <p className="text-xs text-muted-foreground">{candidate.artistCredit}</p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs @lg:grid-cols-[auto_1fr_auto_1fr] @2xl:grid-cols-[auto_1fr]">
              {details.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className={cn('min-w-0 truncate tabular first-letter:uppercase', !value && 'text-muted-foreground')}>{value ?? 'Unknown'}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Part>
        <Part title="Score" aside={<span className="text-sm font-medium tabular">{percent(candidate.score)}<span className="font-normal text-muted-foreground"> / 100</span></span>}>
          <ul className={cn(cardClass, 'grid flex-1 grid-cols-2 content-start gap-x-5 gap-y-3 p-4 @lg:grid-cols-3 @2xl:grid-cols-2')}>
            {parts.map(part => {
              const value = candidate.breakdown[part.key]
              return (
                <li key={part.key} className="flex min-w-0 flex-col gap-1" title={part.hint}>
                  <span className="truncate text-xs text-muted-foreground">{part.label}</span>
                  {value === null ? <span className="text-xs text-muted-foreground">Not compared</span> : <ScoreMeter score={value} className="w-full" />}
                </li>
              )
            })}
          </ul>
        </Part>
      </div>
      <Part title="Track by track">
        <TrackComparison candidate={candidate} files={files} />
      </Part>
    </div>
  )
}

function Different({ when, children }: { when: boolean; children: ReactNode }) {
  return when ? <mark className="rounded-sm bg-destructive/12 px-1 text-destructive">{children}</mark> : <>{children}</>
}

function TrackComparison({ candidate, files }: { candidate: MatchCandidate; files: MatchFile[] }) {
  const byId = new Map(files.map(file => [file.id, file]))
  const extras = candidate.extraFileIds.flatMap(id => byId.get(id) ?? [])
  const multiDisc = candidate.discCount > 1
  // One column of pairs when narrow: the file above the track it was paired with.
  const columns = 'grid grid-cols-[2rem_minmax(0,1fr)_2.5rem] gap-x-3 px-4 @lg:grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_2.5rem]'
  const row = cn(columns, 'items-start py-2 text-sm transition-colors hover:bg-muted/30')
  return (
    <div className={cn(cardClass, 'overflow-hidden')}>
      <div className={cn(columns, 'border-b py-2 text-xs text-muted-foreground')}>
        <span>#</span>
        <span className="@max-lg:hidden">Your files</span>
        <span><span className="@lg:hidden">Your file / </span>On the release</span>
        <span className="text-right">Fit</span>
      </div>
      <ol className="divide-y">
        {candidate.tracks.map(track => {
          const file = track.fileId ? byId.get(track.fileId) : undefined
          const titleDiffers = !!file && !sameText(file.title, track.title)
          const durationDiffers = !!file && track.durationMs !== null && Math.abs(file.durationMs - track.durationMs) > DURATION_TOLERANCE_MS
          return (
            <li key={`${track.disc}-${track.position}`} className={row}>
              <span className="tabular text-muted-foreground">{multiDisc ? `${track.disc}.${track.position}` : track.position}</span>
              <span className="flex min-w-0 flex-col @max-lg:col-start-2 @max-lg:row-start-1">
                {file ? (
                  <>
                    <span className="truncate"><Different when={titleDiffers}>{file.title ?? 'No title'}</Different></span>
                    <span className="truncate text-xs tabular text-muted-foreground"><Different when={durationDiffers}>{formatDuration(file.durationMs)}</Different> · {file.relPath.split('/').pop()}</span>
                  </>
                ) : <span className="italic text-muted-foreground">No file</span>}
              </span>
              <span className="flex min-w-0 flex-col @max-lg:col-start-2 @max-lg:mt-1.5">
                <span className="truncate">{track.title}</span>
                <span className="text-xs tabular text-muted-foreground">
                  {track.durationMs === null ? 'No length' : <Different when={durationDiffers}>{formatDuration(track.durationMs)}</Different>}
                  {durationDiffers && file && track.durationMs !== null && <span className="text-destructive"> · {deltaSeconds(file.durationMs - track.durationMs)}</span>}
                </span>
              </span>
              <span className="text-right text-xs leading-5 tabular text-muted-foreground @max-lg:col-start-3 @max-lg:row-start-1">{track.similarity === null ? '–' : percent(track.similarity)}</span>
            </li>
          )
        })}
        {extras.map(file => (
          <li key={file.id} className={cn(row, 'bg-muted/40')}>
            <span className="tabular text-muted-foreground">{file.track ?? '–'}</span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{file.title ?? 'No title'}</span>
              <span className="truncate text-xs tabular text-muted-foreground">{formatDuration(file.durationMs)} · {file.relPath.split('/').pop()}</span>
            </span>
            <span className="text-xs italic leading-5 text-muted-foreground @max-lg:col-start-2">Not on this release</span>
            <span className="text-right text-xs leading-5 text-muted-foreground @max-lg:col-start-3 @max-lg:row-start-1">–</span>
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
