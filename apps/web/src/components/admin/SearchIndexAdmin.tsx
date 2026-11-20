import { StartCatalogIndexImport, type CatalogIndexImport, type CatalogIndexStatus } from '@squirmy/contracts'
import { Check, DatabaseZap, Download, Trash2, X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { z } from 'zod'
import { useFormSubmit } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Badge, Skeleton, Spinner } from '@/components/ui/feedback'
import { Field, FormError, Input } from '@/components/ui/input'
import { formatBytes, formatDate, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader, ProgressBar, Stat } from './AdminLayout'

type SearchIndexAdminProps = {
  /** Undefined while loading. */
  status: CatalogIndexStatus | undefined
  /** An import was asked for and the worker has not picked it up yet. */
  starting: boolean
  onStart: (request: z.input<typeof StartCatalogIndexImport>) => Promise<unknown>
  onCancel: () => Promise<unknown>
  onRemove: () => Promise<unknown>
}

/** From docs/local-search-index.md, measured on the November 2026 dump. */
const costs = [
  { label: 'Download', value: 'about 2.4 GB' },
  { label: 'Disk once imported', value: 'about 7 GB' },
  { label: 'Free space while importing', value: 'about 20 GB more' },
  { label: 'Time', value: '10 minutes on a fast machine, 30 to 60 on a modest server, plus the download' },
]

const phases = [
  { key: 'download', label: 'Download', detail: 'Reading the dump into staging tables' },
  { key: 'build', label: 'Build', detail: 'Ranking names and building the search indexes' },
  { key: 'swap', label: 'Swap', detail: 'Putting the new index in place' },
] as const

export function SearchIndexAdmin({ status, starting, onStart, onCancel, onRemove }: SearchIndexAdminProps) {
  const [confirm, setConfirm] = useState<'cancel' | 'remove' | null>(null)
  const running = status?.latest?.state === 'running' ? status.latest : null
  const problem = status?.latest && (status.latest.state === 'failed' || status.latest.state === 'cancelled') ? status.latest : null
  return (
    <div className="flex flex-col gap-9">
      <div>
        <AdminHeader
          title="Search index"
          description="An optional copy of MusicBrainz's catalog on this server, so searching for any artist, album or song is answered here in milliseconds instead of asking an online service."
        />
        {!status && <Skeleton className="h-40 rounded-2xl" />}
        {status && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
              <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', status.ready ? 'bg-selection text-accent' : 'bg-surface text-quiet')}><DatabaseZap className="size-5" /></div>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[15px] font-bold">Local search index {status.ready ? <Badge tone="accent">Ready</Badge> : <Badge>Not set up</Badge>}</p>
                <p className="text-[13px] text-muted">
                  {status.ready
                    ? `Dump of ${status.dumpDate ? formatDate(status.dumpDate) : 'an unknown date'}${status.importedAt ? `, imported ${formatRelative(status.importedAt)}` : ''}. MetaBrainz publishes a new one about every two weeks.`
                    : 'Catalog search asks MusicBrainz and Deezer online until an index is imported.'}
                </p>
              </div>
              {status.ready && <Button variant="outline" size="sm" disabled={!!running} onClick={() => setConfirm('remove')}><Trash2 />Remove</Button>}
            </div>
            {status.ready && (
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                <Stat label="Artists" value={status.counts.artists.toLocaleString()} />
                <Stat label="Albums" value={status.counts.albums.toLocaleString()} />
                <Stat label="Songs" value={status.counts.recordings.toLocaleString()} detail={status.active?.recordingsPerArtist ? `At most ${status.active.recordingsPerArtist.toLocaleString()} per artist` : 'Every recording'} />
                <Stat label="On disk" value={formatBytes(status.sizeBytes)} />
              </div>
            )}
          </div>
        )}
      </div>

      {running && <RunningImport run={running} onCancel={() => setConfirm('cancel')} />}
      {starting && !running && (
        <p role="status" className="flex items-center gap-3 rounded-2xl bg-sheet px-4 py-3.5 text-sm font-medium ring-1 ring-stroke"><Spinner className="size-4" />Starting the import…</p>
      )}
      {problem && !running && !starting && (
        <p role="status" className={cn('rounded-2xl px-4 py-3 text-sm', problem.state === 'failed' ? 'bg-danger/10 text-danger' : 'bg-surface text-muted')}>
          <span className="font-semibold">{problem.state === 'failed' ? 'The last import failed' : 'The last import was cancelled'}</span> {formatRelative(problem.finishedAt ?? problem.startedAt)}
          {problem.error && problem.state === 'failed' ? `: ${problem.error}` : '.'} {status?.ready ? 'The index in use was not touched.' : ''}
        </p>
      )}
      {status && !running && !starting && <ImportForm refresh={status.ready} onStart={onStart} />}

      <ConfirmDialog
        open={confirm === 'cancel'}
        onOpenChange={open => { if (!open) setConfirm(null) }}
        title="Stop the import?"
        description={`What it has read so far is thrown away, and a new import starts from the beginning.${status?.ready ? ' The index in use stays as it is.' : ''}`}
        confirmLabel="Stop import"
        onConfirm={onCancel}
      />
      <ConfirmDialog
        open={confirm === 'remove'}
        onOpenChange={open => { if (!open) setConfirm(null) }}
        title="Remove the search index?"
        description={`Catalog search goes back to asking MusicBrainz and Deezer online, and ${status ? formatBytes(status.sizeBytes) : 'its space'} on disk is freed. You can import it again at any time.`}
        confirmLabel="Remove index"
        onConfirm={onRemove}
      />
    </div>
  )
}

function RunningImport({ run, onCancel }: { run: CatalogIndexImport; onCancel: () => void }) {
  const current = phases.findIndex(phase => phase.key === run.phase)
  const downloading = run.phase === 'download'
  return (
    <section aria-label="Import in progress" aria-live="polite" className="flex flex-col gap-4 rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">Importing</p>
          <p className="truncate text-[13px] text-muted">{run.source ?? 'The newest dump from MetaBrainz'} · started {formatRelative(run.startedAt)}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onCancel}><X />Cancel</Button>
      </div>
      <ol className="grid grid-cols-3 gap-2">
        {phases.map((phase, index) => (
          <li key={phase.key} aria-current={index === current ? 'step' : undefined} className="flex flex-col gap-1.5">
            <span className={cn('h-1 rounded-full', index < current ? 'bg-accent' : index === current ? 'animate-pulse bg-accent' : 'bg-stroke')} />
            <span className={cn('flex items-center gap-1 text-xs font-semibold', index === current ? 'text-foreground' : 'text-quiet')}>
              {index < current && <Check className="size-3 text-accent" />}{phase.label}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-1.5">
        <ProgressBar value={downloading && run.totalBytes ? run.bytesRead / run.totalBytes : null} label="Import progress" />
        <p className="flex flex-wrap justify-between gap-x-3 text-xs font-medium text-muted">
          <span>{phases[Math.max(current, 0)]!.detail}</span>
          <span className="tabular">
            {formatBytes(run.bytesRead)}{run.totalBytes ? ` of ${formatBytes(run.totalBytes)}` : ''} · {run.rowsRead.toLocaleString()} songs read
          </span>
        </p>
      </div>
    </section>
  )
}

function Choice({ name, checked, onChange, label, children }: { name: string; checked: boolean; onChange: () => void; label: string; children?: ReactNode }) {
  return (
    <label className={cn('flex cursor-pointer gap-3 rounded-xl px-3.5 py-3 transition-colors', checked ? 'bg-selection' : 'bg-surface hover:bg-overlay')}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-0.5 size-4 shrink-0 accent-(--accent)" />
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-sm font-semibold">{label}</span>
        {children}
      </span>
    </label>
  )
}

function ImportForm({ refresh, onStart }: { refresh: boolean; onStart: SearchIndexAdminProps['onStart'] }) {
  const [latest, setLatest] = useState(true)
  const [source, setSource] = useState('')
  const [limited, setLimited] = useState(false)
  const [limit, setLimit] = useState('100')
  const form = useFormSubmit(StartCatalogIndexImport, onStart)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void form.submit({ source: latest ? undefined : source, recordingsPerArtist: limited ? Number(limit) : null })
  }
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className="px-1">
        <h3 className="text-lg font-bold tracking-tight">{refresh ? 'Import a newer dump' : 'Import the index'}</h3>
        <p className="mt-0.5 text-[13px] text-muted">
          {refresh ? 'Search keeps using the current index until the new one is complete.' : 'It runs in the background at low priority. Search starts using it the moment it is complete.'}
        </p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 px-1 text-[13px] font-semibold text-muted">Dump</legend>
          <Choice name="dump" checked={latest} onChange={() => setLatest(true)} label="The newest dump from MetaBrainz">
            <span className="text-xs text-muted">Downloaded from data.metabrainz.org. CC0, no attribution needed.</span>
          </Choice>
          <Choice name="dump" checked={!latest} onChange={() => setLatest(false)} label="A URL or a file on this server">
            {!latest && (
              <Field label="Dump" htmlFor="dump-source" error={form.errors.source} hint="A .tar.zst canonical dump, e.g. one you downloaded and checked yourself.">
                <Input id="dump-source" value={source} onChange={event => setSource(event.target.value)} placeholder="/srv/dumps/musicbrainz-canonical-dump.tar.zst" className="font-mono text-[13px]" aria-invalid={!!form.errors.source} autoFocus />
              </Field>
            )}
          </Choice>
        </fieldset>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 px-1 text-[13px] font-semibold text-muted">Size</legend>
          <Choice name="size" checked={!limited} onChange={() => setLimited(false)} label="Every recording">
            <span className="text-xs text-muted">The whole catalog, about 30 million songs.</span>
          </Choice>
          <Choice name="size" checked={limited} onChange={() => setLimited(true)} label="Fewer songs for the biggest artists">
            <span className="text-xs text-muted">Keeps each artist&rsquo;s best recordings, studio albums first. Artists and albums stay complete, and famous music is found just as well.</span>
            {limited && (
              <Field label="Songs per artist, at most" htmlFor="per-artist" error={form.errors.recordingsPerArtist}>
                <Input id="per-artist" type="number" min={1} value={limit} onChange={event => setLimit(event.target.value)} className="w-32 tabular" aria-invalid={!!form.errors.recordingsPerArtist} />
              </Field>
            )}
          </Choice>
        </fieldset>
      </div>
      <dl className="grid gap-x-6 gap-y-2 rounded-2xl bg-sheet p-4 text-[13px] ring-1 ring-stroke sm:grid-cols-[auto_1fr]">
        {costs.map(cost => (
          <div key={cost.label} className="contents">
            <dt className="font-semibold">{cost.label}</dt>
            <dd className="text-muted max-sm:mb-1">{cost.value}</dd>
          </div>
        ))}
      </dl>
      <FormError message={form.errors.form} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" pending={form.pending}>{!form.pending && <Download />}{refresh ? 'Import again' : 'Start import'}</Button>
      </div>
    </form>
  )
}
