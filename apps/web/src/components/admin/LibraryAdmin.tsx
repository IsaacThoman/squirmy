import {
  CreateLibraryRootRequest, UpdateLibraryRootRequest,
  type DirectoryListing, type JobQueueStats, type LibraryRoot, type LibraryStats, type OrganizeTemplateInfo, type ServerEvent,
} from '@squirmy/contracts'
import { Briefcase, ChevronRight, Eye, FolderOpen, FolderPlus, MoreHorizontal, RefreshCw, ScanLine, Wand2 } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import type { z } from 'zod'
import { useFormSubmit } from '@/api/errors'
import { rootPathErrors } from '@/api/folders'
import { FolderPicker } from '@/components/auth/FolderPicker'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog, DialogContent } from '@/components/ui/dialog'
import { Badge, EmptyState, ProgressBar, Skeleton, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input, Label } from '@/components/ui/input'
import { DropdownMenu } from '@/components/ui/menu'
import { formatBytes, formatRelative, formatTotalDuration, plural } from '@/lib/format'
import { templateExample } from '@/lib/template'
import { cn } from '@/lib/utils'
import { AdminHeader, DialogForm, Stat } from './AdminLayout'
import { ManagedConfirmation, ManagedSwitch, SwitchRow } from './ManagedSwitch'

export type ScanProgress = Omit<Extract<ServerEvent, { type: 'scan.progress' }>, 'type'>

/** The folder picker's state, owned by the page: the folder on screen and its contents. */
export type FolderBrowser = {
  path: string | undefined
  listing: DirectoryListing | undefined
  error: string | undefined
  onBrowse: (path: string) => void
}

type LibraryAdminProps = {
  /** Undefined while loading. */
  roots: LibraryRoot[] | undefined
  stats: LibraryStats | undefined
  /** Albums waiting in the review queue. */
  openReviews: number | undefined
  /** The latest `scan.progress` of each root, by root id. */
  progress: Record<string, ScanProgress>
  /** The default naming template and its tokens, for managed folders. Undefined while loading. */
  templateInfo: OrganizeTemplateInfo | undefined
  /** A folder whose editor opens once the folders load, from a link such as Organize's. */
  editRootId?: string | null
  onEditorClosed?: () => void
  folders: FolderBrowser
  onScan: (rootId: string) => Promise<unknown>
  onAdd: (request: z.input<typeof CreateLibraryRootRequest>) => Promise<unknown>
  onUpdate: (rootId: string, patch: UpdateLibraryRootRequest) => Promise<unknown>
  onRemove: (rootId: string) => Promise<unknown>
  onFixMatch: () => void
}

type RootDialog = { kind: 'add' } | { kind: 'edit' | 'remove'; root: LibraryRoot }

export function LibraryAdmin({ roots, stats, openReviews, progress, templateInfo, editRootId, onEditorClosed, folders, onScan, onAdd, onUpdate, onRemove, onFixMatch }: LibraryAdminProps) {
  const [opened, setDialog] = useState<RootDialog | null>(null)
  const linked = editRootId ? roots?.find(root => root.id === editRootId) : undefined
  const dialog: RootDialog | null = opened ?? (linked ? { kind: 'edit', root: linked } : null)
  const close = (open: boolean) => {
    if (open) return
    setDialog(null)
    if (linked) onEditorClosed?.()
  }
  return (
    <div>
      <AdminHeader title="Library" description="Folders the server scans. Managed folders are renamed and filed once their music is identified.">
        <Button onClick={onFixMatch}><Wand2 />Fix a match</Button>
        <Button variant="primary" onClick={() => setDialog({ kind: 'add' })}><FolderPlus />Add folder</Button>
      </AdminHeader>

      <LibraryStatistics stats={stats} openReviews={openReviews} />

      {!roots && <div className="flex flex-col gap-3">{[0, 1].map(index => <Skeleton key={index} className="h-28 rounded-2xl" />)}</div>}
      {roots?.length === 0 && (
        <EmptyState
          icon={<FolderOpen />}
          title="No music folders yet"
          description="Add a folder on the server. Squirmy scans it, reads the tags and identifies the albums."
          action={<Button variant="primary" onClick={() => setDialog({ kind: 'add' })}><FolderPlus />Add folder</Button>}
        />
      )}
      <ul className="flex flex-col gap-3">
        {roots?.map(root => (
          <RootCard
            key={root.id}
            root={root}
            live={progress[root.id]}
            onScan={() => void onScan(root.id).catch(() => {})}
            onEdit={() => setDialog({ kind: 'edit', root })}
            onToggle={() => void onUpdate(root.id, { enabled: !root.enabled }).catch(() => {})}
            onRemove={() => setDialog({ kind: 'remove', root })}
          />
        ))}
      </ul>

      <AddRootDialog open={dialog?.kind === 'add'} onOpenChange={close} folders={folders} onAdd={onAdd} />
      {dialog?.kind === 'edit' && <EditRootDialog root={dialog.root} templateInfo={templateInfo} onOpenChange={close} onSave={patch => onUpdate(dialog.root.id, patch)} />}
      <ConfirmDialog
        open={dialog?.kind === 'remove'}
        onOpenChange={close}
        title={dialog?.kind === 'remove' ? `Remove ${dialog.root.name}?` : ''}
        description={dialog?.kind === 'remove' && <>Its {plural(dialog.root.fileCount, 'file')} leave the library. <strong className="font-semibold text-foreground">Nothing on disk is touched</strong>: no file is moved, renamed or deleted, and adding the folder again brings the music back.</>}
        confirmLabel="Remove folder"
        onConfirm={() => dialog?.kind === 'remove' ? onRemove(dialog.root.id) : Promise.resolve()}
      />
    </div>
  )
}

function LibraryStatistics({ stats, openReviews }: { stats: LibraryStats | undefined; openReviews: number | undefined }) {
  if (!stats) return <div className="mb-8 grid grid-cols-2 gap-3 xl:grid-cols-4">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-[104px] rounded-2xl" />)}</div>
  const states = [
    { label: 'Identified', count: stats.matched, className: 'bg-accent' },
    { label: 'In review', count: stats.inReview, className: 'bg-accent/45' },
    { label: 'From tags only', count: stats.unmatched, className: 'bg-quiet/45' },
    { label: 'Waiting', count: stats.pending, className: 'bg-quiet/20' },
  ]
  return (
    <div className="mb-8 flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Songs" value={stats.tracks.toLocaleString()} detail={`${plural(stats.albums, 'album')} · ${plural(stats.artists, 'artist')}`} />
        <Stat label="Playing time" value={stats.durationMs ? formatTotalDuration(stats.durationMs) : '0 min'} detail={`${formatBytes(stats.bytes)} · ${plural(stats.files, 'file')}`} />
        <Stat label="Identified" value={stats.files ? `${Math.round((stats.matched / stats.files) * 100)}%` : '–'} detail={`${stats.matched.toLocaleString()} of ${plural(stats.files, 'file')}`} />
        <Stat
          label="Needs review"
          value={openReviews === undefined ? '–' : openReviews.toLocaleString()}
          detail={openReviews ? <Link to="/admin/reviews" className="text-accent hover:underline">Open the review queue</Link> : 'Nothing waiting'}
        />
      </div>
      {stats.files > 0 && (
        <div className="rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
          <p className="mb-3 text-xs font-semibold text-muted">Identification of {plural(stats.files, 'file')}</p>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
            {states.filter(state => state.count > 0).map(state => (
              <span key={state.label} className={cn('h-full min-w-1.5', state.className)} style={{ flexGrow: state.count }} />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted">
            {states.map(state => (
              <li key={state.label} className="flex items-center gap-1.5">
                <span aria-hidden className={cn('size-2 rounded-full', state.className)} />
                {state.label} <span className="font-semibold tabular text-foreground">{state.count.toLocaleString()}</span>
              </li>
            ))}
            <li className={cn('flex items-center gap-1.5', stats.missing > 0 && 'text-danger')}>
              Missing from disk <span className="font-semibold tabular">{stats.missing.toLocaleString()}</span>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}

const phaseLabels = { discovering: 'Finding files', probing: 'Reading tags', matching: 'Identifying albums' }

/** What a folder is busy with: the live event while one is running, else the root's own flag. */
function activity(root: LibraryRoot, live: ScanProgress | undefined): { label: string; value: number | null; count?: string } | null {
  if (live && live.phase !== 'idle' && (live.phase === 'discovering' || live.processed < live.total)) {
    if (live.phase === 'discovering') return { label: phaseLabels.discovering, value: null, count: `${live.processed.toLocaleString()} found` }
    return { label: phaseLabels[live.phase], value: live.processed / Math.max(live.total, 1), count: `${live.processed.toLocaleString()} of ${live.total.toLocaleString()}` }
  }
  return root.scanning ? { label: 'Scanning', value: null } : null
}

function RootCard({ root, live, onScan, onEdit, onToggle, onRemove }: { root: LibraryRoot; live: ScanProgress | undefined; onScan: () => void; onEdit: () => void; onToggle: () => void; onRemove: () => void }) {
  const busy = activity(root, live)
  const last = root.lastScanStats
  return (
    <li className="rounded-2xl bg-sheet p-4 ring-1 ring-stroke" aria-label={root.name}>
      <div className="flex items-start gap-4">
        <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', root.enabled ? 'bg-selection text-accent' : 'bg-surface text-quiet')}><FolderOpen className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-bold">{root.name}</h3>
            <Badge tone={root.mode === 'managed' ? 'accent' : 'neutral'}>{root.mode === 'managed' ? 'Managed' : 'Read-only'}</Badge>
            {root.watch && root.enabled && <Badge tone="outline"><Eye />Watching</Badge>}
            {!root.enabled && <Badge tone="danger">Disabled</Badge>}
          </div>
          <p dir="rtl" className="mt-0.5 truncate text-left font-mono text-[13px] text-muted" title={root.path}><bdi>{root.path}</bdi></p>
          <p className="mt-1.5 text-xs text-quiet">
            {plural(root.fileCount, 'file')}
            {root.lastScanFinishedAt ? ` · scanned ${formatRelative(root.lastScanFinishedAt)}` : ' · not scanned yet'}
            {last && ` · ${last.filesAdded.toLocaleString()} added, ${last.filesChanged.toLocaleString()} changed, ${last.filesMissing.toLocaleString()} missing`}
            {last?.errors ? <span className="font-medium text-danger"> · {plural(last.errors, 'unreadable file')}</span> : null}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" className="max-sm:hidden" disabled={root.scanning || !root.enabled} onClick={onScan}>
            {root.scanning ? <Spinner className="size-4 text-current" label="Scanning" /> : <ScanLine />}{root.scanning ? 'Scanning' : 'Scan now'}
          </Button>
          <DropdownMenu
            entries={[
              { label: 'Scan now', disabled: root.scanning || !root.enabled, onSelect: onScan },
              { label: 'Edit…', onSelect: onEdit },
              { label: root.enabled ? 'Disable' : 'Enable', onSelect: onToggle },
              { kind: 'separator' },
              { label: 'Remove folder…', danger: true, onSelect: onRemove },
            ]}
            trigger={<IconButton label={`More options for ${root.name}`} size="sm"><MoreHorizontal /></IconButton>}
          />
        </div>
      </div>
      {busy && (
        <div className="mt-4 flex flex-col gap-1.5">
          <ProgressBar value={busy.value} label={`${busy.label} in ${root.name}`} />
          <p className="flex justify-between gap-3 text-xs font-medium text-muted">
            <span>{busy.label}</span>
            {busy.count && <span className="tabular">{busy.count}</span>}
          </p>
        </div>
      )}
    </li>
  )
}

// The name follows the folder on screen until it is typed.
const newRoot = { name: null as string | null, managed: false, watch: true }

function AddRootDialog({ open, onOpenChange, folders, onAdd }: { open: boolean; onOpenChange: (open: boolean) => void; folders: FolderBrowser; onAdd: LibraryAdminProps['onAdd'] }) {
  const [value, setValue] = useState(newRoot)
  const form = useFormSubmit(CreateLibraryRootRequest, onAdd, rootPathErrors)
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setValue(newRoot)
      form.reset()
    }
  }
  const name = value.name ?? folders.listing?.path.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const submit = async () => {
    const request = { name, path: folders.listing?.path ?? '', mode: value.managed ? 'managed' : 'read_only', watch: value.watch }
    if (await form.submit(request)) close(false)
  }
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title="Add a music folder" description="A folder on the server. It is scanned right away; the folder on screen is the one added.">
        <DialogForm onSubmit={() => void submit()} errors={form.errors} pending={form.pending} submitLabel="Add and scan" disabled={!folders.listing}>
          <Field label="Name" htmlFor="root-name" error={form.errors.name}>
            <Input id="root-name" value={name} onChange={event => setValue({ ...value, name: event.target.value })} placeholder="Music" aria-invalid={!!form.errors.name} autoFocus />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-muted">Folder</span>
            <FolderPicker path={folders.path} listing={folders.listing} error={folders.error ?? form.errors.path} onBrowse={path => { form.reset(); folders.onBrowse(path) }} />
          </div>
          <ManagedSwitch checked={value.managed} onChange={managed => setValue({ ...value, managed })} />
          <SwitchRow label="Watch for changes" description="Pick up new and changed files as they appear. Network folders may need the nightly scan instead." checked={value.watch} onChange={watch => setValue({ ...value, watch })} />
        </DialogForm>
      </DialogContent>
    </Dialog>
  )
}

type EditRootProps = { root: LibraryRoot; templateInfo: OrganizeTemplateInfo | undefined; onOpenChange: (open: boolean) => void; onSave: (patch: UpdateLibraryRootRequest) => Promise<unknown> }

function EditRootDialog({ root, templateInfo, onOpenChange, onSave }: EditRootProps) {
  const [value, setValue] = useState({ name: root.name, managed: root.mode === 'managed', watch: root.watch, enabled: root.enabled, template: root.template })
  const [confirming, setConfirming] = useState(false)
  const form = useFormSubmit(UpdateLibraryRootRequest, onSave)
  const save = async () => {
    const patch = { name: value.name, mode: value.managed ? 'managed' : 'read_only', watch: value.watch, enabled: value.enabled }
    // Only a changed template is sent, so saving other options never trips over it.
    if (await form.submit(value.template === root.template ? patch : { ...patch, template: value.template })) onOpenChange(false)
  }
  // Becoming managed lets the server change files, so it is said plainly before it is saved.
  const submit = () => (value.managed && root.mode !== 'managed' && !confirming ? setConfirming(true) : void save())
  return (
    <Dialog open onOpenChange={onOpenChange}>
      {confirming ? (
        <ManagedConfirmation name={value.name.trim() || root.name} errors={form.errors} pending={form.pending} onConfirm={submit} />
      ) : (
        <DialogContent title={`Edit ${root.name}`} description={<span className="break-all font-mono text-[13px]">{root.path}</span>}>
          <DialogForm onSubmit={submit} errors={form.errors} pending={form.pending} submitLabel="Save">
            <Field label="Name" htmlFor="edit-root-name" error={form.errors.name}>
              <Input id="edit-root-name" value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} aria-invalid={!!form.errors.name} autoFocus />
            </Field>
            <ManagedSwitch checked={value.managed} onChange={managed => setValue({ ...value, managed })} />
            {value.managed && <TemplateField value={value.template} onChange={template => setValue({ ...value, template })} info={templateInfo} error={form.errors.template} />}
            <SwitchRow label="Watch for changes" description="Pick up new and changed files as they appear." checked={value.watch} onChange={watch => setValue({ ...value, watch })} />
            <SwitchRow label="Enabled" description="A disabled folder is not scanned or watched. Its music stays in the library." checked={value.enabled} onChange={enabled => setValue({ ...value, enabled })} />
          </DialogForm>
        </DialogContent>
      )}
    </Dialog>
  )
}

/** A managed folder's naming template: null is the server's default, shown as text to start editing from. */
function TemplateField({ value, onChange, info, error }: { value: string | null; onChange: (value: string | null) => void; info: OrganizeTemplateInfo | undefined; error: string | undefined }) {
  if (!info) return <Skeleton className="h-24 rounded-xl" />
  const text = value ?? info.defaultTemplate
  const example = templateExample(text, info.tokens.map(token => token.token))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <Label htmlFor="root-template">Naming template</Label>
        {value === null
          ? <Badge>Default</Badge>
          : <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => onChange(null)}>Reset to default</Button>}
      </div>
      <Input
        id="root-template" value={text} spellCheck={false} autoCapitalize="none" autoComplete="off" className="font-mono text-[13px]"
        aria-invalid={!!error} aria-describedby="root-template-message"
        // The default typed out in full is still the default, and follows the server's if it changes.
        onChange={event => onChange(event.target.value === info.defaultTemplate ? null : event.target.value)}
      />
      <p id="root-template-message" className={cn('text-xs', error ? 'font-medium text-danger' : 'text-quiet')}>
        {error ?? (example ? <>For example <span className="block font-mono text-muted [overflow-wrap:anywhere]">{example.split('/').map((part, index) => <Fragment key={index}>{index > 0 && <>/<wbr /></>}{part}</Fragment>)}</span></> : 'Use only the tokens below, with matching brackets.')}
      </p>
      <details className="group rounded-xl bg-surface text-xs">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3.5 py-2.5 font-semibold text-muted [&::-webkit-details-marker]:hidden">
          Tokens<ChevronRight aria-hidden className="size-4 text-quiet transition-transform group-open:rotate-90" />
        </summary>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3.5 pb-3">
          {info.tokens.map(({ token, description }) => (
            <div key={token} className="contents">
              <dt className="font-mono text-foreground">{`{${token}}`}</dt>
              <dd className="text-muted">{description}</dd>
            </div>
          ))}
        </dl>
        <p className="px-3.5 pb-3 text-quiet">Text in [square brackets] is left out when a token inside it has no value.</p>
      </details>
    </div>
  )
}

type JobsAdminProps = {
  /** Undefined while loading. */
  jobs: JobQueueStats[] | undefined
  /** When the numbers were fetched; they refresh on their own every few seconds. */
  updatedAt: number
  onRefresh: () => void
}

export function JobsAdmin({ jobs, updatedAt, onRefresh }: JobsAdminProps) {
  return (
    <div>
      <AdminHeader title="Jobs" description="Background work. Heavy jobs such as loudness run at low priority so new music is browsable first.">
        <Button onClick={onRefresh}><RefreshCw />Refresh</Button>
      </AdminHeader>
      {jobs && (
        <p className="-mt-3 mb-4 flex items-center gap-2 px-1 text-xs font-medium text-quiet">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-accent" />
          Live · updated {formatRelative(new Date(updatedAt).toISOString())}
        </p>
      )}
      {jobs?.length === 0 && <EmptyState icon={<Briefcase />} title="No queues yet" description="Queues appear once the server has work of that kind." />}
      {!jobs && <Skeleton className="h-48 rounded-2xl" />}
      {jobs && jobs.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-sheet ring-1 ring-stroke">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stroke text-left text-xs font-semibold uppercase tracking-wider text-quiet">
                <th className="px-4 py-3 font-semibold">Queue</th>
                <th className="px-4 py-3 text-right font-semibold">Queued</th>
                <th className="px-4 py-3 text-right font-semibold">Active</th>
                <th className="px-4 py-3 text-right font-semibold">Failed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stroke">
              {jobs.map(job => (
                <tr key={job.name} className="transition-colors hover:bg-overlay">
                  <td className="px-4 py-3 font-mono text-[13px]">
                    <span className={cn('mr-2.5 inline-block size-2 rounded-full', job.active ? 'bg-accent' : 'bg-stroke')} aria-hidden />
                    {job.name}
                  </td>
                  <td className="px-4 py-3 text-right tabular">{job.queued.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular">{job.active}</td>
                  <td className={cn('px-4 py-3 text-right tabular', job.failed ? 'font-semibold text-danger' : 'text-quiet')}>{job.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
