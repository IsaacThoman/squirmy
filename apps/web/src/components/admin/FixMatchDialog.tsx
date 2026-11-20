import { queryKeys, type AlbumDetail, type MatchActionResult, type MatchCandidate, type MatchFile } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, RotateCcw, Search, Tags } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { errorMessage } from '@/api/errors'
import { useApi } from '@/api/services'
import { Cover } from '@/components/music/Cover'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Badge, Skeleton, Spinner } from '@/components/ui/feedback'
import { FormError } from '@/components/ui/input'
import { SearchField } from '@/components/ui/search-field'
import { toast } from '@/lib/toast'
import { CandidateComparison, CandidatePicker } from './MatchCompare'

export type FixMatchProps = {
  albumId: string
  onOpenChange: (open: boolean) => void
  /** After a rematch or unmatch; the files may now be on another album (`result.albumId`). */
  onDone?: (result: MatchActionResult) => void
}

type Action = { kind: 'release'; candidate: MatchCandidate } | { kind: 'auto' | 'unmatch' }

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
    meta: { silent: true },
  })
  const act = useMutation({
    mutationFn: (action: Action) => action.kind === 'release'
      ? api.matching.rematch(albumId, { releaseMbid: action.candidate.releaseMbid })
      : action.kind === 'auto' ? api.matching.rematch(albumId) : api.matching.unmatch(albumId),
    onSuccess: (result, action) => {
      toast({
        title: action.kind === 'release' ? `Matched to ${action.candidate.title}` : action.kind === 'auto' ? 'Matching again' : 'Playing from its tags',
        description: action.kind === 'release' ? 'The files are locked to this release.' : action.kind === 'auto' ? 'The matcher looks at the album again in the background.' : 'The files are locked to their tags.',
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminReviews() })
      onOpenChange(false)
      onDone?.(result)
    },
    meta: { inline: true },
  })
  return (
    <FixMatchView
      album={album.data}
      files={candidates.data?.files}
      candidates={candidates.data?.items}
      searching={candidates.isFetching}
      searchError={candidates.isError ? errorMessage(candidates.error) : undefined}
      actionError={act.isError ? errorMessage(act.error) : undefined}
      pending={act.isPending ? act.variables?.kind ?? null : null}
      onSearch={next => setQuery(next.trim() || undefined)}
      onAction={action => act.mutate(action)}
      onOpenChange={onOpenChange}
    />
  )
}

type FixMatchViewProps = {
  album: AlbumDetail | undefined
  /** Undefined until the first search answers. */
  files: MatchFile[] | undefined
  candidates: MatchCandidate[] | undefined
  searching: boolean
  searchError: string | undefined
  actionError: string | undefined
  pending: Action['kind'] | null
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

export function FixMatchView({ album, files, candidates, searching, searchError, actionError, pending, onSearch, onAction, onOpenChange }: FixMatchViewProps) {
  const [text, setText] = useState<string | null>(null)
  const [chosen, setChosen] = useState<string | null>(null)
  const candidate = candidates?.find(item => item.releaseMbid === chosen) ?? candidates?.[0]
  const search = (event: FormEvent) => {
    event.preventDefault()
    setChosen(null)
    onSearch(text ?? '')
  }
  const busy = pending !== null
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Fix match" description="Pick the MusicBrainz release these files are, match them automatically again, or keep them as their tags describe them." className="max-w-5xl">
        <div className="flex items-center gap-4 rounded-2xl bg-sheet p-3 ring-1 ring-stroke">
          {album ? (
            <>
              <Cover artwork={album.artwork} size={96} className="size-14 rounded-lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-bold">{album.title}</p>
                <p className="truncate text-sm text-muted">{album.artistCredit}{album.year ? ` · ${album.year}` : ''}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-quiet">
                  <span>{identification(album, files)}</span>
                  {album.mbid && (
                    <a className="inline-flex items-center gap-1 font-semibold text-accent hover:underline" href={`https://musicbrainz.org/release-group/${album.mbid}`} target="_blank" rel="noreferrer">
                      Release group<ExternalLink className="size-3" />
                    </a>
                  )}
                </p>
              </div>
              {files && <Badge className="max-sm:hidden">{files.length} files</Badge>}
            </>
          ) : <Skeleton className="h-14 flex-1" />}
        </div>

        <form onSubmit={search} className="flex gap-2">
          <SearchField
            value={text ?? (album ? `${album.artistCredit} - ${album.title}` : '')}
            onValueChange={setText}
            placeholder="Artist - album, a release link or an MBID"
            aria-label="Search MusicBrainz"
            className="flex-1"
          />
          <Button type="submit" pending={searching} disabled={busy}>{!searching && <Search />}Search</Button>
        </form>

        {searchError && <FormError message={searchError} />}
        {!candidates && !searchError && (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-sheet py-12 text-center ring-1 ring-stroke">
            <Spinner />
            <p className="max-w-sm text-sm text-muted">Searching MusicBrainz. Its public server answers one request a second, so this can take a little while.</p>
          </div>
        )}
        {candidates?.length === 0 && (
          <p className="rounded-2xl bg-sheet px-4 py-6 text-center text-sm text-muted ring-1 ring-stroke">Nothing found. Try another spelling, or paste a MusicBrainz release link.</p>
        )}
        {candidates && candidates.length > 0 && files && candidate && (
          <>
            {candidates.length > 1 && <CandidatePicker name="fix-match" candidates={candidates} selected={candidate.releaseMbid} onSelect={setChosen} />}
            <CandidateComparison candidate={candidate} files={files} />
          </>
        )}

        <FormError message={actionError} />
        <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-col-reverse gap-2 border-t border-stroke bg-sheet px-6 py-4 sm:flex-row sm:items-center">
          <div className="flex flex-wrap gap-2 sm:flex-1">
            <Button size="sm" variant="ghost" disabled={busy} pending={pending === 'auto'} onClick={() => onAction({ kind: 'auto' })}>{pending !== 'auto' && <RotateCcw />}Match automatically</Button>
            <Button size="sm" variant="ghost" disabled={busy} pending={pending === 'unmatch'} onClick={() => onAction({ kind: 'unmatch' })}>{pending !== 'unmatch' && <Tags />}Use the tags</Button>
          </div>
          <Button variant="primary" disabled={!candidate || busy} pending={pending === 'release'} onClick={() => candidate && onAction({ kind: 'release', candidate })}>
            {pending !== 'release' && <Check />}Use this release
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
