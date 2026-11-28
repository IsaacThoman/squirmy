import { API_PREFIX, HISTORY_IMPORT_MAX_BYTES, HistoryImportSource, queryKeys, type HistoryImport } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileUp } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { errorMessage } from '@/api/errors'
import { useApi } from '@/api/services'
import { SectionHeader } from '@/components/music/SectionHeader'
import { Button } from '@/components/ui/button'
import { Badge, ProgressBar, Spinner } from '@/components/ui/feedback'
import { QueryState } from '@/components/ui/query-state'
import { plural } from '@/lib/format'

const sources = {
  listenbrainz: { name: 'ListenBrainz', accept: '.json,.jsonl,.ndjson,.listens', hint: 'Choose a JSON or JSON Lines listens file from your export.' },
  lastfm: { name: 'Last.fm', accept: '.csv', hint: 'Choose a CSV with artist, album, track and timestamp.' },
  spotify: { name: 'Spotify', accept: '.json', hint: 'Choose an extended streaming history audio JSON file.' },
}

const jobsKey = ['history-imports'] as const
const pending = (job: HistoryImport) => job.status === 'queued' || job.status === 'running'
const select = 'h-9 max-w-full rounded-md border bg-background px-2.5 text-sm focus-visible:outline-2 focus-visible:outline-ring'

export function HistoryTransfer() {
  const api = useApi()
  const cache = useQueryClient()
  const [source, setSource] = useState<HistoryImportSource>('listenbrainz')
  const [file, setFile] = useState<File>()
  const [progress, setProgress] = useState<number | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const jobs = useQuery({
    queryKey: jobsKey,
    queryFn: () => api.userdata.historyImports(),
    refetchInterval: query => query.state.data?.items.some(pending) ? 1500 : false,
    meta: { silent: true },
  })
  const upload = useMutation({
    mutationFn: (chosen: File) => api.userdata.importHistory(source, { data: chosen, name: chosen.name }, {
      onProgress: ({ loaded, total }) => setProgress(total === null ? null : loaded / total),
    }),
    onSuccess: job => {
      if (fileInput.current) fileInput.current.value = ''
      setFile(undefined)
      cache.setQueryData(jobsKey, (old: typeof jobs.data) => ({ items: [job, ...(old?.items ?? []).filter(item => item.id !== job.id)].slice(0, 10) }))
      void cache.invalidateQueries({ queryKey: jobsKey })
      void cache.invalidateQueries({ queryKey: queryKeys.replay() })
    },
    meta: { silent: true },
  })
  const tooLarge = (file?.size ?? 0) > HISTORY_IMPORT_MAX_BYTES
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (file && !tooLarge) {
      setProgress(null)
      upload.mutate(file)
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4 md:p-5">
      <SectionHeader title="Listening history" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <form onSubmit={submit} className="min-w-0">
          <h3 className="mb-2 text-sm font-semibold">Import history</h3>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Import source" className={select} disabled={upload.isPending} value={source} onChange={event => {
              setSource(HistoryImportSource.parse(event.target.value))
              setFile(undefined)
              upload.reset()
              if (fileInput.current) fileInput.current.value = ''
            }}>
              {HistoryImportSource.options.map(id => <option key={id} value={id}>{sources[id].name}</option>)}
            </select>
            <input ref={fileInput} type="file" aria-label="History file" accept={sources[source].accept} disabled={upload.isPending}
              className="max-w-full text-sm file:mr-2 file:rounded-md file:border-0 file:bg-muted file:px-2 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
              onChange={event => { setFile(event.target.files?.[0]); upload.reset() }} />
            <Button variant="primary" type="submit" disabled={!file || tooLarge} pending={upload.isPending}>{!upload.isPending && <FileUp />}Import</Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{sources[source].hint} Up to 128 MB per file.</p>
          {upload.isPending && progress !== null && <ProgressBar className="mt-3" value={progress} label="Uploading history" />}
          {tooLarge && <p role="alert" className="mt-2 text-sm text-destructive">Choose a file up to 128 MB.</p>}
          {upload.error && <p role="alert" className="mt-2 text-sm text-destructive">{errorMessage(upload.error)}</p>}
        </form>
        <div className="border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-5">
          <h3 className="mb-2 text-sm font-semibold">Export history</h3>
          <div className="flex flex-wrap gap-2">
            {(['json', 'csv'] as const).map(format => <Button key={format} asChild variant="outline">
              <a href={`${API_PREFIX}/me/history/export?format=${format}`} download><Download />{format.toUpperCase()}</a>
            </Button>)}
          </div>
        </div>
      </div>
      <QueryState query={jobs} loading={<Spinner className="mt-4" label="Loading recent imports" />} errorTitle="Recent imports did not load" errorClassName="mt-4">
        {({ items }) => items.length > 0 && <ul aria-label="Recent imports" className="mt-5 divide-y border-t text-sm">
          {items.map(job => <li key={job.id} className="flex flex-wrap items-start gap-x-2.5 gap-y-1 py-2">
            <span className="font-medium">{sources[job.source].name}</span>
            <Badge tone={job.status === 'failed' ? 'danger' : job.status === 'completed' ? 'accent' : 'neutral'} className="capitalize">{job.status}</Badge>
            <span className="text-muted-foreground" role={pending(job) ? 'status' : undefined}>
              {plural(job.processed, 'row')} processed · {job.matched.toLocaleString()} matched · {job.unmatched.toLocaleString()} unmatched
              {job.duplicates > 0 && ` · ${plural(job.duplicates, 'duplicate')}`}
              {job.ignored > 0 && ` · ${job.ignored.toLocaleString()} ignored`}
            </span>
            {job.error && <p className="basis-full text-destructive">{job.error}</p>}
          </li>)}
        </ul>}
      </QueryState>
    </section>
  )
}
