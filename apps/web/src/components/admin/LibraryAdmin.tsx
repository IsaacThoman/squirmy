import type { JobQueueStats, LibraryRoot, LibraryStats, ServerEvent } from '@squirmy/contracts'
import { Eye, FolderOpen, FolderPlus, MoreHorizontal, RefreshCw, ScanLine } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Badge, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input } from '@/components/ui/input'
import { DropdownMenu } from '@/components/ui/menu'
import { Switch } from '@/components/ui/switch'
import { formatBytes, formatRelative, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader, ProgressBar, Stat } from './AdminLayout'

type ScanProgress = Extract<ServerEvent, { type: 'scan.progress' }>

type LibraryAdminProps = {
  roots: LibraryRoot[]
  stats: LibraryStats
  progress: Omit<ScanProgress, 'type'>[]
  onScan: (rootId: string) => void
  onRootAction: (rootId: string, action: 'edit' | 'toggle' | 'remove') => void
  onAddRoot: (root: { name: string; path: string; managed: boolean }) => void
}

const phases = { discovering: 'Finding files', probing: 'Reading tags', matching: 'Matching', idle: 'Idle' }

export function LibraryAdmin({ roots, stats, progress, onScan, onRootAction, onAddRoot }: LibraryAdminProps) {
  const [adding, setAdding] = useState(false)
  return (
    <div>
      <AdminHeader title="Library" description="Folders the server scans. Managed folders are renamed and filed once their music is identified.">
        <Button variant="primary" onClick={() => setAdding(true)}><FolderPlus />Add folder</Button>
      </AdminHeader>

      <div className="mb-8 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Stat label="Songs" value={stats.tracks.toLocaleString()} detail={`${stats.albums.toLocaleString()} albums · ${stats.artists.toLocaleString()} artists`} />
        <Stat label="On disk" value={formatBytes(stats.bytes)} detail={plural(stats.files, 'file')} />
        <Stat label="Identified" value={`${Math.round((stats.matched / Math.max(stats.tracks, 1)) * 100)}%`} detail={`${stats.unmatched.toLocaleString()} from tags only`} />
        <Stat label="Needs review" value={String(stats.inReview)} detail={<Link to="/admin/reviews" className="text-accent hover:underline">Open the review queue</Link>} />
      </div>

      <ul className="flex flex-col gap-3">
        {roots.map(root => {
          const live = progress.find(item => item.rootId === root.id)
          return (
            <li key={root.id} className="rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
              <div className="flex items-start gap-4">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-selection text-accent"><FolderOpen className="size-5" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[15px] font-bold">{root.name}</h3>
                    <Badge tone={root.mode === 'managed' ? 'accent' : 'neutral'}>{root.mode === 'managed' ? 'Managed' : 'Read-only'}</Badge>
                    {root.watch && <Badge tone="outline"><Eye />Watching</Badge>}
                    {!root.enabled && <Badge tone="danger">Disabled</Badge>}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[13px] text-muted">{root.path}</p>
                  <p className="mt-1.5 text-xs text-quiet">
                    {plural(root.fileCount, 'file')}
                    {root.lastScanFinishedAt && ` · last scanned ${formatRelative(root.lastScanFinishedAt)}`}
                    {root.lastScanStats && ` · ${root.lastScanStats.filesAdded} added, ${root.lastScanStats.filesMissing} missing`}
                    {root.lastScanStats?.errors ? <span className="text-danger"> · {plural(root.lastScanStats.errors, 'error')}</span> : null}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" disabled={root.scanning} onClick={() => onScan(root.id)}>
                    {root.scanning ? <Spinner className="size-4" label="Scanning" /> : <ScanLine />}{root.scanning ? 'Scanning' : 'Scan now'}
                  </Button>
                  <DropdownMenu
                    entries={[
                      { label: 'Edit', onSelect: () => onRootAction(root.id, 'edit') },
                      { label: root.enabled ? 'Disable' : 'Enable', onSelect: () => onRootAction(root.id, 'toggle') },
                      { kind: 'separator' },
                      { label: 'Remove folder', danger: true, onSelect: () => onRootAction(root.id, 'remove') },
                    ]}
                    trigger={<IconButton label={`More options for ${root.name}`} size="sm"><MoreHorizontal /></IconButton>}
                  />
                </div>
              </div>
              {live && (
                <div className="mt-4 flex flex-col gap-1.5">
                  <ProgressBar value={live.processed / Math.max(live.total, 1)} label={`Scanning ${root.name}`} />
                  <p className="flex justify-between text-xs font-medium text-muted">
                    <span>{phases[live.phase]}</span>
                    <span className="tabular">{live.processed.toLocaleString()} of {live.total.toLocaleString()}</span>
                  </p>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <AddRootDialog open={adding} onOpenChange={setAdding} onAdd={onAddRoot} />
    </div>
  )
}

function AddRootDialog({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (open: boolean) => void; onAdd: LibraryAdminProps['onAddRoot'] }) {
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [managed, setManaged] = useState(false)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onAdd({ name: name.trim(), path: path.trim(), managed })
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add a music folder" description="A folder on the server. It is scanned right away and watched for changes.">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Name" htmlFor="root-name"><Input id="root-name" value={name} onChange={event => setName(event.target.value)} placeholder="Music" required /></Field>
          <Field label="Path" htmlFor="root-path" hint="As the server sees it, e.g. /music inside the container.">
            <Input id="root-path" value={path} onChange={event => setPath(event.target.value)} placeholder="/srv/music" className="font-mono" required />
          </Field>
          <ManagedSwitch checked={managed} onChange={setManaged} />
          <DialogFooter>
            <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
            <Button type="submit" variant="primary" disabled={!name.trim() || !path.trim()}>Add folder</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ManagedSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-xl bg-surface px-3.5 py-3">
      <span>
        <span className="block text-sm font-semibold">Let Squirmy organize this folder</span>
        <span className="block text-xs text-muted">Identified music is renamed into Artist/Album folders. Every move can be previewed and undone.</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  )
}

export function JobsAdmin({ jobs, onRefresh }: { jobs: JobQueueStats[]; onRefresh: () => void }) {
  return (
    <div>
      <AdminHeader title="Jobs" description="Background work. Heavy jobs such as loudness run at low priority so new music is browsable first.">
        <Button onClick={onRefresh}><RefreshCw />Refresh</Button>
      </AdminHeader>
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
    </div>
  )
}
