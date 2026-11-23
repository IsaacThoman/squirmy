import { queryKeys, type AlbumDetail, type MatchActionResult, type MatchCandidate, type MatchFile } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CircleCheck, ExternalLink, RotateCcw, Search, Tags } from 'lucide-react'
import { useId, useState, type FormEvent } from 'react'
import { errorMessage } from '@/api/errors'
import { useApi } from '@/api/services'
import { Cover } from '@/components/music/Cover'
import { Button } from '@/components/ui/button'
import { Dialog, DialogFrame, DialogTitle } from '@/components/ui/dialog'
import { Badge, Skeleton, Spinner } from '@/components/ui/feedback'
import { FormError } from '@/components/ui/input'
import { SearchField } from '@/components/ui/search-field'
import { cn } from '@/lib/utils'
import { CandidateComparison, CandidatePicker } from './MatchCompare'
import { cardClass } from './Panel'

export type FixMatchProps = {
  albumId: string
  onOpenChange: (open: boolean) => void
  /** As the dialog closes after a rematch or unmatch; the files may now be on another album (`result.albumId`). */
  onDone?: (result: MatchActionResult) => void
}

type Action = { kind: 'release'; candidate: MatchCandidate } | { kind: 'auto' | 'unmatch' }

/** What a choice did, in the words the dialog says once it is made. */
function doneText(action: Action): string {
  if (action.kind === 'release') return `Matched to ${action.candidate.title}. The files are locked to this release.`
  return action.kind === 'auto' ? 'Matching again. The matcher looks at the album again in the background.' : 'Playing from its tags. The files are locked to their tags.'
}

/** Fix match for one album: loads what it needs, searches MusicBrainz and applies the choice. */
export default function FixMatchDialog({ albumId, onOpenChange, onDone }: FixMatchProps) {
  const api = useApi()
  const queryClient = useQueryClient()
  // Undefined searches from the files' tags; the field starts with the album as it is now.
  const [query, setQuery] = useState<string>()
  const album = useQuery({ queryKey: queryKeys.album(albumId), queryFn: () => api.catalog.album(albumId) })
  const candidates = useQuery({
    queryKey: [...queryKeys.admin(), 'candidates', albumId, query ?? null],
    queryFn: () => api.matching.candidates(albumId, { query }),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const act = useMutation({
    mutationFn: (action: Action) => action.kind === 'release'
      ? api.matching.rematch(albumId, { releaseMbid: action.candidate.releaseMbid })
      : action.kind === 'auto' ? api.matching.rematch(albumId) : api.matching.unmatch(albumId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.adminReviews() }),
  })
  // The dialog stays to say what was done; what follows (another album's page) waits for it to close.
  const close = (open: boolean) => {
    onOpenChange(open)
    if (!open && act.data) onDone?.(act.data)
  }
  return (
    <FixMatchView
      album={album.data}
      albumError={album.isError ? errorMessage(album.error) : undefined}
      files={candidates.data?.files}
      candidates={candidates.data?.items}
      searching={candidates.isFetching}
      searchError={candidates.isError ? errorMessage(candidates.error) : undefined}
      actionError={act.isError ? errorMessage(act.error) : undefined}
      pending={act.isPending ? act.variables?.kind ?? null : null}
      done={act.isSuccess && act.variables ? doneText(act.variables) : undefined}
      onSearch={next => setQuery(next.trim() || undefined)}
      onAction={action => act.mutate(action)}
      onOpenChange={close}
    />
  )
}

type FixMatchViewProps = {
  album: AlbumDetail | undefined
  /** Why the album did not load, said where it would be. */
  albumError?: string
  /** Undefined until the first search answers. */
  files: MatchFile[] | undefined
  candidates: MatchCandidate[] | undefined
  searching: boolean
  searchError: string | undefined
  actionError: string | undefined
  pending: Action['kind'] | null
  /** What the choice made did; the dialog then offers only Done. */
  done?: string
  onSearch: (query: string) => void
  onAction: (action: Action) => void
  onOpenChange: (open: boolean) => void
}

/** How the files are identified now, in words. */
function identification(album: AlbumDetail, files: MatchFile[] | undefined): string {
  const locked = files?.length && files.every(file => file.locked)
  const status = files?.[0]?.status
  if (status === 'review') return 'Waiting in the review queue'
  if (status === 'pending') return 'Waiting to be identified'
  if (album.mbid) return locked ? 'Identified on MusicBrainz, chosen by an admin' : 'Identified on MusicBrainz'
  return locked ? 'Kept as its tags describe it' : 'Playing from its tags'
}

export function FixMatchView({ album, albumError, files, candidates, searching, searchError, actionError, pending, done, onSearch, onAction, onOpenChange }: FixMatchViewProps) {
  const [text, setText] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const descriptionId = useId()
  const candidate = candidates?.find(item => item.releaseMbid === chosen) ?? candidates?.[0]
  const search = (event: FormEvent) => {
    event.preventDefault()
    setChosen(null)
    onSearch(text ?? '')
  }
  const busy = pending !== null || done !== undefined
  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* Its head and its actions stay put; what is between them scrolls. */}
      <DialogFrame aria-describedby={descriptionId} className="flex flex-col overflow-hidden sm:max-w-5xl">
        <div className="flex flex-col gap-2 border-b px-4 py-4 pr-12 sm:px-6 sm:py-5 sm:pr-12">
          <DialogTitle className="text-lg font-semibold leading-none">Fix match</DialogTitle>
          <p id={descriptionId} className="text-sm text-muted-foreground">Pick the MusicBrainz release these files are, match them automatically again, or keep them as their tags describe them.</p>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
          <div className={cn(cardClass, 'flex items-center gap-3 p-3')}>
            {album ? (
              <>
                <Cover artwork={album.artwork} size={96} className="size-12" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{album.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{album.artistCredit}{album.year ? ` · ${album.year}` : ''}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span>{identification(album, files)}</span>
                    {album.mbid && (
                      <a className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline" href={`https://musicbrainz.org/release-group/${album.mbid}`} target="_blank" rel="noreferrer">
                        Release group<ExternalLink className="size-3" />
                      </a>
                    )}
                  </p>
                </div>
                {files && <Badge className="tabular max-sm:hidden">{files.length} files</Badge>}
              </>
            ) : albumError ? <p className="py-1 text-sm text-destructive">{albumError}</p> : <Skeleton className="h-12 flex-1" />}
          </div>

          <form onSubmit={search} className="flex gap-2">
            <SearchField
              value={text ?? (album ? `${album.artistCredit} - ${album.title}` : '')}
              onValueChange={setText}
              placeholder="Artist - album, a release link or an MBID"
              aria-label="Search MusicBrainz"
              className="flex-1"
            />
            <Button type="submit" variant="outline" pending={searching} disabled={busy}>{!searching && <Search />}Search</Button>
          </form>

          {searchError && <FormError message={searchError} />}
          {!candidates && !searchError && (
            <div className={cn(cardClass, 'flex flex-col items-center gap-3 px-4 py-12 text-center')}>
              <Spinner />
              <p className="max-w-sm text-sm text-muted-foreground">Searching MusicBrainz. Its public server answers one request a second, so this can take a little while.</p>
            </div>
          )}
          {candidates?.length === 0 && (
            <p className={cn(cardClass, 'px-4 py-8 text-center text-sm text-muted-foreground')}>Nothing found. Try another spelling, or paste a MusicBrainz release link.</p>
          )}
          {candidates && candidates.length > 0 && files && candidate && (
            <>
              {candidates.length > 1 && <CandidatePicker name="fix-match" candidates={candidates} selected={candidate.releaseMbid} onSelect={setChosen} />}
              <CandidateComparison candidate={candidate} files={files} />
            </>
          )}
          <FormError message={actionError} />
        </div>

        <div className="flex flex-col-reverse gap-2 border-t px-4 py-3 sm:flex-row sm:items-center sm:px-6">
          <div role="status" className="contents">
            {done && <p className="flex min-w-0 items-start gap-2 text-sm sm:flex-1"><CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />{done}</p>}
          </div>
          {done ? <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button> : (
            <>
              <div className="flex flex-wrap gap-2 max-sm:justify-between sm:flex-1">
                <Button size="sm" variant="ghost" disabled={busy} pending={pending === 'auto'} onClick={() => onAction({ kind: 'auto' })}>{pending !== 'auto' && <RotateCcw />}Match automatically</Button>
                <Button size="sm" variant="ghost" disabled={busy} pending={pending === 'unmatch'} onClick={() => onAction({ kind: 'unmatch' })}>{pending !== 'unmatch' && <Tags />}Use the tags</Button>
              </div>
              <Button variant="primary" disabled={!candidate || busy} pending={pending === 'release'} onClick={() => candidate && onAction({ kind: 'release', candidate })}>
                {pending !== 'release' && <Check />}Use this release
              </Button>
            </>
          )}
        </div>
      </DialogFrame>
    </Dialog>
  )
}
