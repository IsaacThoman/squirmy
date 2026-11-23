import {
  CreateLibraryRootRequest, UpdateLibraryRootRequest,
  type AcquisitionUsage, type DirectoryListing, type JobQueueStats, type LibraryRoot, type LibraryStats, type OrganizeTemplateInfo, type ServerEvent,
} from '@squirmy/contracts'
import { Briefcase, ChevronRight, Eye, FolderOpen, FolderPlus, MoreHorizontal, Pencil, Power, RefreshCw, ScanLine, Trash2, Wand2 } from 'lucide-react'
import { Fragment, useState, type ReactNode } from 'react'
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
import { ManagedConfirmation, ManagedSwitchRow, SwitchRow } from './ManagedSwitch'
import { useNote } from './note'
import { cardClass, DataTable, FolderPath, InlineNote, OptionGroup, Panel, Td, Th, Tr } from './Panel'

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
  /** The provider cache, which `stats` leaves out. Undefined while loading. */
  cache?: AcquisitionUsage
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
  /** Answers whether a scan was started; false when one is already running. */
  onScan: (rootId: string) => Promise<{ queued: boolean }>
  onAdd: (request: z.input<typeof CreateLibraryRootRequest>) => Promise<unknown>
  onUpdate: (rootId: string, patch: UpdateLibraryRootRequest) => Promise<unknown>
  onRemove: (rootId: string) => Promise<unknown>
  onFixMatch: () => void
  /** Said in place of each part whose first read failed; the parts that loaded stay usable. */
  failures?: Partial<Record<'roots' | 'stats', ReactNode>>
}

type RootDialog = { kind: 'add' } | { kind: 'edit' | 'remove'; root: LibraryRoot }

export function LibraryAdmin({ roots, stats, cache, openReviews, progress, templateInfo, editRootId, onEditorClosed, folders, onScan, onAdd, onUpdate, onRemove, onFixMatch, failures }: LibraryAdminProps) {
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
        <Button size="sm" variant="outline" onClick={onFixMatch}><Wand2 />Fix a match</Button>
        <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'add' })}><FolderPlus />Add folder</Button>
      </AdminHeader>

      <div className="flex flex-col gap-7">
        <LibraryStatistics stats={stats} cache={cache} openReviews={openReviews} failure={failures?.stats} />

        <Panel title="Folders">
          {!roots && failures?.roots}
          {!roots && !failures?.roots && (
            <div className={cn(cardClass, 'divide-y')}>
              {[0, 1].map(index => (
                <div key={index} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-9 rounded-lg" />
                  <div className="flex flex-1 flex-col gap-2"><Skeleton className="h-4 w-36" /><Skeleton className="h-3 w-64 max-w-full" /></div>
                </div>
              ))}
            </div>
          )}
          {roots?.length === 0 && (
            <EmptyState
              className={cardClass}
              icon={<FolderOpen />}
              title="No music folders yet"
              description="Add a folder on the server. Squirmy scans it, reads the tags and identifies the albums."
              action={<Button variant="outline" onClick={() => setDialog({ kind: 'add' })}><FolderPlus />Add folder</Button>}
            />
          )}
          {roots && roots.length > 0 && (
            <ul className={cn(cardClass, 'divide-y')}>
              {roots.map(root => (
                <RootRow
                  key={root.id}
                  root={root}
                  live={progress[root.id]}
                  onScan={() => onScan(root.id)}
                  onEdit={() => setDialog({ kind: 'edit', root })}
                  onToggle={() => onUpdate(root.id, { enabled: !root.enabled })}
                  onRemove={() => setDialog({ kind: 'remove', root })}
                />
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <AddRootDialog open={dialog?.kind === 'add'} onOpenChange={close} folders={folders} onAdd={onAdd} />
      {dialog?.kind === 'edit' && <EditRootDialog root={dialog.root} templateInfo={templateInfo} onOpenChange={close} onSave={patch => onUpdate(dialog.root.id, patch)} />}
      <ConfirmDialog
        open={dialog?.kind === 'remove'}
        onOpenChange={close}
        title={dialog?.kind === 'remove' ? `Remove ${dialog.root.name}?` : ''}
        description={dialog?.kind === 'remove' && <>Its {plural(dialog.root.fileCount, 'file')} leave the library. <strong className="font-medium text-foreground">Nothing on disk is touched</strong>: no file is moved, renamed or deleted, and adding the folder again brings the music back.</>}
        confirmLabel="Remove folder"
        onConfirm={() => dialog?.kind === 'remove' ? onRemove(dialog.root.id) : Promise.resolve()}
      />
    </div>
  )
}

/**
 * The collection's numbers. Fetched music is cache, not collection (product decision 20),
 * so it is left out here and only pointed to, which is why a folder can list more files.
 */
function LibraryStatistics({ stats, cache, openReviews, failure }: { stats: LibraryStats | undefined; cache: AcquisitionUsage | undefined; openReviews: number | undefined; failure?: ReactNode }) {
  if (!stats && failure) return failure
  if (!stats) return <div className="@container"><div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">{[0, 1, 2, 3].map(index => <Skeleton key={index} className="h-24 rounded-xl" />)}</div></div>
  const states = [
    { label: 'Identified', count: stats.matched, className: 'bg-primary' },
    { label: 'In review', count: stats.inReview, className: 'bg-primary/45' },
    { label: 'From tags only', count: stats.unmatched, className: 'bg-muted-foreground/45' },
    { label: 'Waiting', count: stats.pending, className: 'bg-muted-foreground/20' },
  ]
  return (
    <Panel
      title="Collection"
      description={(
        <>
          Music you brought: scanned, uploaded or imported.
          {cache && cache.cachedFiles > 0 && <> The {plural(cache.cachedFiles, 'file')} ({formatBytes(cache.cachedBytes)}) fetched for playing are cache, counted under <Link to="/admin/providers" className="text-primary underline-offset-4 hover:underline">Providers</Link> instead.</>}
        </>
      )}
    >
      <div className="@container flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
          <Stat label="Songs" value={stats.tracks.toLocaleString()} detail={`${plural(stats.albums, 'album')} · ${plural(stats.artists, 'artist')}`} />
          <Stat label="Playing time" value={stats.durationMs ? formatTotalDuration(stats.durationMs) : '0 min'} detail={`${formatBytes(stats.bytes)} · ${plural(stats.files, 'file')}`} />
          <Stat label="Identified" value={stats.files ? `${Math.round((stats.matched / stats.files) * 100)}%` : '–'} detail={`${stats.matched.toLocaleString()} of ${plural(stats.files, 'file')}`} />
          <Stat
            label="Needs review"
            value={openReviews === undefined ? '–' : openReviews.toLocaleString()}
            detail={openReviews ? <Link to="/admin/reviews" className="text-primary underline-offset-4 hover:underline">Open the review queue</Link> : 'Nothing waiting'}
          />
        </div>
        {stats.files > 0 && (
          <div className={cn(cardClass, 'p-4')}>
            <p className="text-xs text-muted-foreground">Identification of {plural(stats.files, 'file')}</p>
            <div className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
              {states.filter(state => state.count > 0).map(state => (
                <span key={state.label} className={cn('h-full min-w-1.5', state.className)} style={{ flexGrow: state.count }} />
              ))}
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
              {states.map(state => (
                <li key={state.label} className="flex items-center gap-1.5">
                  <span aria-hidden className={cn('size-2 rounded-full', state.className)} />
                  {state.label} <span className="font-medium tabular text-foreground">{state.count.toLocaleString()}</span>
                </li>
              ))}
              <li className={cn('flex items-center gap-1.5', stats.missing > 0 && 'text-destructive')}>
                Missing from disk <span className={cn('font-medium tabular', !stats.missing && 'text-foreground')}>{stats.missing.toLocaleString()}</span>
              </li>
            </ul>
          </div>
        )}
      </div>
    </Panel>
  )
}

/**
 * "1,204 files", or "12 in the collection · 110 cached" when the folder also holds the
 * provider cache, so its count matches the collection numbers above.
 */
function folderFiles(root: LibraryRoot) {
  const cached = root.cachedFileCount ?? 0
  if (!cached) return plural(root.fileCount, 'file')
  return `${(root.fileCount - cached).toLocaleString()} in the collection · ${cached.toLocaleString()} cached`
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

type RootRowProps = { root: LibraryRoot; live: ScanProgress | undefined; onScan: () => Promise<{ queued: boolean }>; onEdit: () => void; onToggle: () => Promise<unknown>; onRemove: () => void }

/**
 * A folder, with what it is busy with. A scan that starts shows as its progress, and a folder
 * enabled or disabled as its badge; the row says only what does not show: a scan already
 * running, or why the server refused.
 */
function RootRow({ root, live, onScan, onEdit, onToggle, onRemove }: RootRowProps) {
  const { note, run } = useNote()
  const scan = () => void run(onScan, ({ queued }) => (queued ? null : 'Already scanning. The folder is scanned again once this scan finishes.'))
  const toggle = () => void run(onToggle)
  const busy = activity(root, live)
  const last = root.lastScanStats
  return (
    <li className="px-4 py-3" aria-label={root.name}>
      <div className="flex items-start gap-3">
        <div className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground', !root.enabled && 'opacity-50')}><FolderOpen className="size-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="text-sm font-medium">{root.name}</h4>
            <Badge tone={root.mode === 'managed' ? 'accent' : 'neutral'}>{root.mode === 'managed' ? 'Managed' : 'Read-only'}</Badge>
            {root.watch && root.enabled && <Badge tone="outline"><Eye />Watching</Badge>}
            {!root.enabled && <Badge tone="danger">Disabled</Badge>}
          </div>
          <FolderPath path={root.path} className="mt-0.5" />
          <p className="mt-1 text-xs tabular text-muted-foreground">
            {folderFiles(root)}
            {root.lastScanFinishedAt ? ` · scanned ${formatRelative(root.lastScanFinishedAt)}` : ' · not scanned yet'}
            {last && ` · ${last.filesAdded.toLocaleString()} added, ${last.filesChanged.toLocaleString()} changed, ${last.filesMissing.toLocaleString()} missing`}
            {last?.errors ? <span className="text-destructive"> · {plural(last.errors, 'unreadable file')}</span> : null}
          </p>
          <InlineNote note={note} className="mt-1" />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="outline" className="max-sm:hidden" disabled={root.scanning || !root.enabled} onClick={scan}>
            {root.scanning ? <Spinner className="size-4 text-current" label="Scanning" /> : <ScanLine />}{root.scanning ? 'Scanning' : 'Scan now'}
          </Button>
          <DropdownMenu
            entries={[
              { label: 'Scan now', icon: <ScanLine />, disabled: root.scanning || !root.enabled, onSelect: scan },
              { label: 'Edit…', icon: <Pencil />, onSelect: onEdit },
              { label: root.enabled ? 'Disable' : 'Enable', icon: <Power />, onSelect: toggle },
              { kind: 'separator' },
              { label: 'Remove folder…', icon: <Trash2 />, danger: true, onSelect: onRemove },
            ]}
            trigger={<IconButton label={`More options for ${root.name}`} size="sm"><MoreHorizontal /></IconButton>}
          />
        </div>
      </div>
      {busy && (
        <div className="mt-3 flex flex-col gap-1.5 sm:pl-12">
          <ProgressBar value={busy.value} label={`${busy.label} in ${root.name}`} />
          <p className="flex justify-between gap-3 text-xs text-muted-foreground">
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
      <DialogContent title="Add a music folder" description="A folder on the server. It is scanned right away; the folder on screen is the one added." className="sm:max-w-lg">
        <DialogForm onSubmit={() => void submit()} errors={form.errors} pending={form.pending} submitLabel="Add and scan" disabled={!folders.listing}>
          <Field label="Name" htmlFor="root-name" error={form.errors.name}>
            <Input id="root-name" value={name} onChange={event => setValue({ ...value, name: event.target.value })} placeholder="Music" aria-invalid={!!form.errors.name} autoFocus />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium leading-none">Folder</span>
            <FolderPicker path={folders.path} listing={folders.listing} error={folders.error ?? form.errors.path} onBrowse={path => { form.reset(); folders.onBrowse(path) }} />
          </div>
          <OptionGroup>
            <ManagedSwitchRow checked={value.managed} onChange={managed => setValue({ ...value, managed })} />
            <SwitchRow label="Watch for changes" description="Pick up new and changed files as they appear. Network folders may need the nightly scan instead." checked={value.watch} onChange={watch => setValue({ ...value, watch })} />
          </OptionGroup>
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
        <DialogContent title={`Edit ${root.name}`} description={<span className="font-mono text-xs wrap-anywhere">{root.path.split('/').map((part, index) => <Fragment key={index}>{index > 0 && <>/<wbr /></>}{part}</Fragment>)}</span>} className="sm:max-w-lg">
          <DialogForm onSubmit={submit} errors={form.errors} pending={form.pending} submitLabel="Save">
            <Field label="Name" htmlFor="edit-root-name" error={form.errors.name}>
              <Input id="edit-root-name" value={value.name} onChange={event => setValue({ ...value, name: event.target.value })} aria-invalid={!!form.errors.name} autoFocus />
            </Field>
            <OptionGroup>
              <div>
                <ManagedSwitchRow checked={value.managed} onChange={managed => setValue({ ...value, managed })} />
                {value.managed && (
                  <div className="px-3 pb-3">
                    <TemplateField
                      value={value.template} info={templateInfo} error={form.errors.template}
                      // The server's reason is about the template it refused; the example takes over once it changes.
                      onChange={template => {
                        setValue({ ...value, template })
                        if (form.errors.template) form.reset()
                      }}
                    />
                  </div>
                )}
              </div>
              <SwitchRow label="Watch for changes" description="Pick up new and changed files as they appear." checked={value.watch} onChange={watch => setValue({ ...value, watch })} />
              <SwitchRow label="Enabled" description="A disabled folder is not scanned or watched. Its music stays in the library." checked={value.enabled} onChange={enabled => setValue({ ...value, enabled })} />
            </OptionGroup>
          </DialogForm>
        </DialogContent>
      )}
    </Dialog>
  )
}

/** A managed folder's naming template: null is the server's default, shown as text to start editing from. */
function TemplateField({ value, onChange, info, error }: { value: string | null; onChange: (value: string | null) => void; info: OrganizeTemplateInfo | undefined; error: string | undefined }) {
  if (!info) return <Skeleton className="h-24" />
  const text = value ?? info.defaultTemplate
  const example = templateExample(text, info.tokens.map(token => token.token))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-5 items-center justify-between gap-3">
        <Label htmlFor="root-template">Naming template</Label>
        {value === null
          ? <Badge>Default</Badge>
          : <Button variant="link" className="text-xs" onClick={() => onChange(null)}>Reset to default</Button>}
      </div>
      <Input
        id="root-template" value={text} spellCheck={false} autoCapitalize="none" autoComplete="off" className="font-mono md:text-xs"
        aria-invalid={!!error} aria-describedby="root-template-message"
        // The default typed out in full is still the default, and follows the server's if it changes.
        onChange={event => onChange(event.target.value === info.defaultTemplate ? null : event.target.value)}
      />
      <p id="root-template-message" className={cn('text-xs', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ?? (example ? <>For example <span className="block font-mono text-foreground wrap-anywhere">{example.split('/').map((part, index) => <Fragment key={index}>{index > 0 && <>/<wbr /></>}{part}</Fragment>)}</span></> : 'Use only the tokens below, with matching brackets.')}
      </p>
      <details className="group rounded-md border bg-muted/40 text-xs">
        <summary className="flex list-none items-center justify-between px-3 py-2 font-medium [&::-webkit-details-marker]:hidden">
          Tokens<ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
        </summary>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 px-3 pb-2.5">
          {info.tokens.map(({ token, description }) => (
            <div key={token} className="contents">
              <dt className="font-mono">{`{${token}}`}</dt>
              <dd className="text-muted-foreground">{description}</dd>
            </div>
          ))}
        </dl>
        <p className="px-3 pb-2.5 text-muted-foreground">Text in [square brackets] is left out when a token inside it has no value.</p>
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
  /** Said in place of the table when the first read failed. */
  failure?: ReactNode
}

export function JobsAdmin({ jobs, updatedAt, onRefresh, failure }: JobsAdminProps) {
  return (
    <div>
      <AdminHeader title="Jobs" description="Background work. Heavy jobs such as loudness run at low priority so new music is browsable first.">
        <Button size="sm" variant="outline" onClick={onRefresh}><RefreshCw />Refresh</Button>
      </AdminHeader>
      {jobs && (
        <p className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />
          Live · updated {formatRelative(new Date(updatedAt).toISOString())}
        </p>
      )}
      {jobs?.length === 0 && <EmptyState className={cardClass} icon={<Briefcase />} title="No queues yet" description="Queues appear once the server has work of that kind." />}
      {!jobs && (failure ?? <Skeleton className="h-48 rounded-xl" />)}
      {jobs && jobs.length > 0 && (
        <DataTable>
          <thead>
            <tr className="border-b">
              <Th className="w-full">Queue</Th>
              <Th className="text-right sm:min-w-32">Queued</Th>
              <Th className="text-right sm:min-w-32">Active</Th>
              <Th className="text-right sm:min-w-32">Failed</Th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => (
              <Tr key={job.name}>
                <Td className="font-mono text-xs">
                  <span className="flex items-center gap-2.5">
                    <span className={cn('size-2 shrink-0 rounded-full', job.active ? 'bg-primary' : 'bg-muted-foreground/30')} aria-hidden />
                    <span className="wrap-anywhere">{job.name.split('.').map((part, index) => <Fragment key={index}>{index > 0 && <>.<wbr /></>}{part}</Fragment>)}</span>
                  </span>
                </Td>
                <Td className={cn('text-right tabular', !job.queued && 'text-muted-foreground')}>{job.queued.toLocaleString()}</Td>
                <Td className={cn('text-right tabular', job.active ? 'font-medium' : 'text-muted-foreground')}>{job.active}</Td>
                <Td className={cn('text-right tabular', job.failed ? 'font-medium text-destructive' : 'text-muted-foreground')}>{job.failed}</Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  )
}
