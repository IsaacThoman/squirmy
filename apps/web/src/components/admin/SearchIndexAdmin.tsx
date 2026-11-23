import { StartCatalogIndexImport, type CatalogIndexImport, type CatalogIndexStatus } from '@squirmy/contracts'
import { Check, CircleAlert, CircleSlash, DatabaseZap, Download, Trash2, X } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import type { z } from 'zod'
import { useFormSubmit } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Badge, ProgressBar, Skeleton, Spinner } from '@/components/ui/feedback'
import { Field, FormError, Input } from '@/components/ui/input'
import { formatBytes, formatDate, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader, Stat } from './AdminLayout'
import { cardClass, Panel } from './Panel'

type SearchIndexAdminProps = {
  /** Undefined while loading. */
  status: CatalogIndexStatus | undefined
  /** An import was asked for and the worker has not picked it up yet. */
  starting: boolean
  onStart: (request: z.input<typeof StartCatalogIndexImport>) => Promise<unknown>
  onCancel: () => Promise<unknown>
  onRemove: () => Promise<unknown>
  /** Said in place of the index's state when it did not load. */
  failure?: ReactNode
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

export function SearchIndexAdmin({ status, starting, onStart, onCancel, onRemove, failure }: SearchIndexAdminProps) {
  const [confirm, setConfirm] = useState<'cancel' | 'remove' | null>(null)
  const running = status?.latest?.state === 'running' ? status.latest : null
  const problem = status?.latest && (status.latest.state === 'failed' || status.latest.state === 'cancelled') ? status.latest : null
  return (
    <div>
      <AdminHeader
        title="Search index"
        description="An optional copy of MusicBrainz's catalog on this server, so searching for any artist, album or song is answered here in milliseconds instead of asking an online service."
      />
      <div className="flex flex-col gap-7">
        {!status && (failure ?? <Skeleton className="h-[74px] rounded-xl" />)}
        {status && (
          <div className="@container flex flex-col gap-3">
            <div className={cn(cardClass, 'flex flex-wrap items-center gap-3 p-4')}>
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground"><DatabaseZap className="size-4" /></div>
              <div className="min-w-0 flex-1 basis-56">
                <p className="flex items-center gap-2 text-sm font-medium">Local search index {status.ready ? <Badge tone="accent">Ready</Badge> : <Badge>Not set up</Badge>}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {status.ready
                    ? `Dump of ${status.dumpDate ? formatDate(status.dumpDate) : 'an unknown date'}${status.importedAt ? `, imported ${formatRelative(status.importedAt)}` : ''}. MetaBrainz publishes a new one about every two weeks.`
                    : 'Catalog search asks MusicBrainz and Deezer online until an index is imported.'}
                </p>
              </div>
              {status.ready && <Button variant="outline" size="sm" disabled={!!running} onClick={() => setConfirm('remove')}><Trash2 />Remove</Button>}
            </div>
            {status.ready && (
              <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
                <Stat label="Artists" value={status.counts.artists.toLocaleString()} />
                <Stat label="Albums" value={status.counts.albums.toLocaleString()} />
                <Stat label="Songs" value={status.counts.recordings.toLocaleString()} detail={status.active?.recordingsPerArtist ? `At most ${status.active.recordingsPerArtist.toLocaleString()} per artist` : 'Every recording'} />
                <Stat label="On disk" value={formatBytes(status.sizeBytes)} />
              </div>
            )}
          </div>
        )}

        {running && <RunningImport run={running} onCancel={() => setConfirm('cancel')} />}
        {starting && !running && (
          <p role="status" className={cn(cardClass, 'flex items-center gap-3 px-4 py-3 text-sm')}><Spinner className="size-4" />Starting the import…</p>
        )}
        {problem && !running && !starting && (
          <div role="status" className={cn('flex gap-3 rounded-xl border px-4 py-3', problem.state === 'failed' ? 'border-destructive/30 bg-destructive/10' : 'bg-muted/40')}>
            {problem.state === 'failed'
              ? <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              : <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            <div className="min-w-0 text-sm">
              <p className={cn('font-medium', problem.state === 'failed' && 'text-destructive')}>
                {problem.state === 'failed' ? 'The last import failed' : 'The last import was cancelled'} {formatRelative(problem.finishedAt ?? problem.startedAt)}
              </p>
              {((problem.error && problem.state === 'failed') || status?.ready) && (
                <p className="mt-0.5 text-xs text-muted-foreground wrap-anywhere">
                  {problem.error && problem.state === 'failed' && `${problem.error.replace(/[.\s]*$/, '')}. `}
                  {status?.ready && 'The index in use was not touched.'}
                </p>
              )}
            </div>
          </div>
        )}
        {status && !running && !starting && <ImportForm refresh={status.ready} onStart={onStart} />}
      </div>

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
    <section aria-label="Import in progress" aria-live="polite" className={cn(cardClass, 'flex flex-col gap-4 p-4')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Importing</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{run.source ?? 'The newest dump from MetaBrainz'} · started {formatRelative(run.startedAt)}</p>
        </div>
        <Button size="sm" variant="outline" onClick={onCancel}><X />Cancel</Button>
      </div>
      <ol className="grid grid-cols-3 gap-2">
        {phases.map((phase, index) => (
          <li key={phase.key} aria-current={index === current ? 'step' : undefined} className="flex flex-col gap-1.5">
            <span className={cn('h-1 rounded-full', index < current ? 'bg-primary' : index === current ? 'animate-pulse bg-primary' : 'bg-muted')} />
            <span className={cn('flex items-center gap-1 text-xs', index === current ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              {index < current && <Check className="size-3 text-primary" />}{phase.label}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-1.5">
        <ProgressBar value={downloading && run.totalBytes ? run.bytesRead / run.totalBytes : null} label="Import progress" />
        <p className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
          <span>{phases[Math.max(current, 0)]!.detail}</span>
          <span className="tabular">
            {formatBytes(run.bytesRead)}{run.totalBytes ? ` of ${formatBytes(run.totalBytes)}` : ''} · {run.rowsRead.toLocaleString()} songs read
          </span>
        </p>
      </div>
    </section>
  )
}

/** A radio button as a row: what it chooses and a line about it, then whatever the choice needs once made. */
function Choice({ name, checked, onChange, label, description, children }: { name: string; checked: boolean; onChange: () => void; label: string; description: string; children?: ReactNode }) {
  return (
    <div className={cn('rounded-lg border transition-colors', checked ? 'bg-accent/50' : 'hover:bg-accent/30')}>
      <label className="flex cursor-pointer gap-3 px-3 py-2.5">
        <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-0.5 size-4 shrink-0 accent-primary" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">{description}</span>
        </span>
      </label>
      {children && <div className="pb-3 pl-10 pr-3">{children}</div>}
    </div>
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
    <Panel
      title={refresh ? 'Import a newer dump' : 'Import the index'}
      description={refresh ? 'Search keeps using the current index until the new one is complete.' : 'It runs in the background at low priority. Search starts using it the moment it is complete.'}
    >
      <form onSubmit={submit} noValidate className={cn(cardClass, 'divide-y')}>
        <div className="grid gap-5 p-4 lg:grid-cols-2">
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Dump</legend>
            <Choice name="dump" checked={latest} onChange={() => setLatest(true)} label="The newest dump from MetaBrainz" description="Downloaded from data.metabrainz.org. CC0, no attribution needed." />
            <Choice name="dump" checked={!latest} onChange={() => setLatest(false)} label="A URL or a file on this server" description="A .tar.zst canonical dump, e.g. one you downloaded and checked yourself.">
              {!latest && (
                <Field label="Dump" htmlFor="dump-source" error={form.errors.source}>
                  <Input id="dump-source" value={source} onChange={event => setSource(event.target.value)} placeholder="/srv/dumps/musicbrainz-canonical-dump.tar.zst" className="font-mono md:text-xs" aria-invalid={!!form.errors.source} autoFocus />
                </Field>
              )}
            </Choice>
          </fieldset>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">Size</legend>
            <Choice name="size" checked={!limited} onChange={() => setLimited(false)} label="Every recording" description="The whole catalog, about 30 million songs." />
            <Choice name="size" checked={limited} onChange={() => setLimited(true)} label="Fewer songs for the biggest artists" description="Keeps each artist’s best recordings, studio albums first. Artists and albums stay complete, and famous music is found just as well.">
              {limited && (
                <Field label="Songs per artist, at most" htmlFor="per-artist" error={form.errors.recordingsPerArtist}>
                  <Input id="per-artist" type="number" min={1} value={limit} onChange={event => setLimit(event.target.value)} className="w-32 tabular" aria-invalid={!!form.errors.recordingsPerArtist} />
                </Field>
              )}
            </Choice>
          </fieldset>
        </div>
        <dl className="grid gap-x-6 gap-y-1.5 p-4 text-sm sm:grid-cols-[auto_1fr]">
          {costs.map(cost => (
            <div key={cost.label} className="contents">
              <dt className="text-muted-foreground">{cost.label}</dt>
              <dd className="max-sm:mb-1.5">{cost.value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-col gap-3 px-4 py-3">
          <FormError message={form.errors.form} />
          <div className="flex justify-end">
            <Button type="submit" size="sm" variant="primary" pending={form.pending}>{!form.pending && <Download />}{refresh ? 'Import again' : 'Start import'}</Button>
          </div>
        </div>
      </form>
    </Panel>
  )
}
