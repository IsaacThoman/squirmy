import { ORGANIZE_TAGS_NOT_REVERTED, type LibraryRoot, type OrganizeAlbumMoves, type OrganizeBatch, type OrganizeBatchStatus, type OrganizeBatchSummary, type OrganizeMove } from '@squirmy/contracts'
import { ArrowRight, Check, ChevronRight, Eye, FolderTree, History, Undo2, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Badge, EmptyState, ProgressBar, Skeleton } from '@/components/ui/feedback'
import { Select } from '@/components/ui/select'
import { formatRelative, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader } from './AdminLayout'
import { SwitchRow } from './ManagedSwitch'

export type OrganizeOptions = { includeUnmatched: boolean; writeTags: boolean }

type OrganizeAdminProps = {
  /** Managed folders; undefined while loading. */
  roots: LibraryRoot[] | undefined
  rootId: string | null
  onRootChange: (rootId: string) => void
  /** The folder's latest preview while it is still unapplied. */
  preview: OrganizeBatch | undefined
  /** The server's default naming template, to say whether a preview used it. */
  defaultTemplate: string | undefined
  /** A batch of the folder being applied or undone, with its live counts. */
  running: OrganizeBatchSummary | null
  /** Applied, failed and undone batches of every folder, newest first. */
  history: OrganizeBatchSummary[] | undefined
  onPreview: (options: OrganizeOptions) => Promise<unknown>
  /** Applies the preview, or only the given albums of it. */
  onApply: (albumIds: string[] | null) => Promise<unknown>
  onRevert: (batch: OrganizeBatchSummary) => Promise<unknown>
  onFixMatch: (albumId: string) => void
}

export function OrganizeAdmin({ roots, rootId, onRootChange, preview, defaultTemplate, running, history, onPreview, onApply, onRevert, onFixMatch }: OrganizeAdminProps) {
  const [options, setOptions] = useState<OrganizeOptions>({ includeUnmatched: false, writeTags: false })
  const [previewing, setPreviewing] = useState(false)
  const [undoing, setUndoing] = useState<OrganizeBatchSummary | null>(null)
  const root = roots?.find(item => item.id === rootId)
  const requestPreview = async () => {
    setPreviewing(true)
    await onPreview(options).catch(() => {})
    setPreviewing(false)
  }
  return (
    <div className="flex flex-col gap-9">
      <div>
        <AdminHeader title="Organize" description="Files music in managed folders by what it is. Nothing moves until you apply a preview, and every batch can be undone." />
        {roots?.length === 0 && (
          <EmptyState
            className="rounded-2xl bg-sheet ring-1 ring-stroke"
            icon={<FolderTree />}
            title="No managed folders"
            description="Organize works on folders Squirmy may change. Make one managed from Library: edit the folder and let Squirmy organize it."
            action={<Button asChild variant="primary"><Link to="/admin/library">Go to Library</Link></Button>}
          />
        )}
        {!roots && <Skeleton className="h-44 rounded-2xl" />}
        {root && (
          <div className="flex flex-col gap-4 rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-muted">Folder</p>
                {roots!.length > 1
                  ? <Select label="Managed folder" value={root.id} onValueChange={onRootChange} options={roots!.map(item => ({ value: item.id, label: item.name }))} className="mt-1" />
                  : <p className="text-[15px] font-bold">{root.name}</p>}
                <p dir="rtl" className="mt-1 truncate text-left font-mono text-xs text-muted" title={root.path}><bdi>{root.path}</bdi></p>
              </div>
              <Button variant="primary" pending={previewing} disabled={!!running} onClick={() => void requestPreview()}>{!previewing && <Eye />}Preview</Button>
            </div>
            <div className="grid gap-2 xl:grid-cols-2">
              <SwitchRow
                label="Include unidentified music"
                description="Also file albums that are not identified, named from their own tags. Off: only identified or approved albums move."
                checked={options.includeUnmatched}
                onChange={includeUnmatched => setOptions({ ...options, includeUnmatched })}
              />
              <SwitchRow
                label="Write tags"
                description="Write the identified titles, artists and album into the files. Undo moves files back but does not take tags out."
                checked={options.writeTags}
                onChange={writeTags => setOptions({ ...options, writeTags })}
              />
            </div>
          </div>
        )}
      </div>

      {running && <RunningBatch batch={running} />}
      {root && !running && preview && <Preview key={preview.id} batch={preview} defaultTemplate={defaultTemplate} onApply={onApply} onFixMatch={onFixMatch} />}

      {history && history.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="flex items-center gap-2 px-1 text-lg font-bold tracking-tight"><History className="size-5 text-quiet" />History</h3>
          <ul className="divide-y divide-stroke overflow-hidden rounded-2xl bg-sheet ring-1 ring-stroke">
            {history.map(batch => (
              <li key={batch.id} className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                    {batch.rootName}<StatusBadge status={batch.status} />{batch.writeTags && <Badge tone="outline">Tags</Badge>}
                  </p>
                  <p className="mt-0.5 text-[13px] text-muted">{batchSummary(batch)}</p>
                  <p className="text-xs text-quiet">
                    {batch.revertedAt ? `Undone ${formatRelative(batch.revertedAt)}` : batch.appliedAt ? `Applied ${formatRelative(batch.appliedAt)}` : `Started ${formatRelative(batch.createdAt)}`}
                  </p>
                </div>
                {batch.status === 'applied' && <Button size="sm" variant="outline" disabled={!!running} onClick={() => setUndoing(batch)}><Undo2 />Undo</Button>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={!!undoing}
        onOpenChange={open => { if (!open) setUndoing(null) }}
        title="Undo this batch?"
        description={undoing && (
          <>
            {plural(undoing.counts.applied, 'file')} in {undoing.rootName} move back to where they were, and folders the batch created are removed once empty.{' '}
            {undoing.writeTags ? <strong className="font-semibold text-foreground">{ORGANIZE_TAGS_NOT_REVERTED}</strong> : 'This batch wrote no tags.'}
          </>
        )}
        confirmLabel="Undo batch"
        onConfirm={() => undoing ? onRevert(undoing) : Promise.resolve()}
      />
    </div>
  )
}

const statusLabels: Record<OrganizeBatchStatus, string> = {
  planned: 'Preview', applying: 'Applying', applied: 'Applied', failed: 'Failed', reverting: 'Undoing', reverted: 'Undone',
}

function StatusBadge({ status }: { status: OrganizeBatchStatus }) {
  return <Badge tone={status === 'failed' ? 'danger' : status === 'applied' ? 'accent' : 'neutral'}>{statusLabels[status]}</Badge>
}

function batchSummary(batch: OrganizeBatchSummary): string {
  const { counts } = batch
  const parts = [
    counts.applied && `${plural(counts.applied, 'move')} applied`,
    counts.reverted && `${counts.reverted.toLocaleString()} undone`,
    counts.notReverted && `${counts.notReverted.toLocaleString()} left in place`,
    counts.failed && `${counts.failed.toLocaleString()} failed`,
    counts.skipped && `${counts.skipped.toLocaleString()} skipped`,
    counts.tagsWritten && `tags written to ${plural(counts.tagsWritten, 'file')}`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing moved'
}

function RunningBatch({ batch }: { batch: OrganizeBatchSummary }) {
  const { counts } = batch
  const undoing = batch.status === 'reverting'
  const done = undoing ? counts.reverted + counts.notReverted : counts.applied + counts.failed
  const total = undoing ? done + counts.applied : done + counts.planned
  return (
    <section aria-live="polite" className="flex flex-col gap-2 rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
      <p className="text-[15px] font-semibold">{undoing ? 'Undoing' : 'Applying'} a batch in {batch.rootName}</p>
      <ProgressBar value={total ? done / total : null} label={undoing ? 'Undoing' : 'Applying'} />
      <p className="flex justify-between gap-3 text-xs font-medium text-muted">
        <span>{undoing ? 'Moving files back' : 'Moving files'}{counts.failed ? ` · ${counts.failed} failed` : ''}</span>
        <span className="tabular">{done.toLocaleString()} of {total.toLocaleString()}</span>
      </p>
      <p className="text-xs text-quiet">Previews and other batches in this folder wait until it finishes.</p>
    </section>
  )
}

function Preview({ batch, defaultTemplate, onApply, onFixMatch }: { batch: OrganizeBatch; defaultTemplate: string | undefined; onApply: OrganizeAdminProps['onApply']; onFixMatch: (albumId: string) => void }) {
  const selectable = batch.albums.filter(album => album.albumId && album.moves.some(move => move.status === 'planned'))
  const [selected, setSelected] = useState<Set<string>>(() => new Set(selectable.map(album => album.albumId!)))
  const [applying, setApplying] = useState(false)
  const { counts } = batch
  const all = selected.size === selectable.length
  const apply = async () => {
    setApplying(true)
    await onApply(all ? null : [...selected]).catch(() => {})
    setApplying(false)
  }
  const toggle = (albumId: string, on: boolean) => setSelected(current => {
    const next = new Set(current)
    if (on) next.add(albumId)
    else next.delete(albumId)
    return next
  })
  const notes = [
    counts.untrusted && `${plural(counts.untrusted, 'file')} not identified ${counts.untrusted === 1 ? 'stays' : 'stay'} put`,
    counts.unchanged && `${counts.unchanged.toLocaleString()} already in place`,
    counts.skipped && `${counts.skipped.toLocaleString()} skipped`,
    counts.sidecars && `${plural(counts.sidecars, 'cover or sidecar file')} travel along`,
  ].filter(Boolean)
  return (
    <section aria-label="Preview" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div>
          <h3 className="text-lg font-bold tracking-tight">
            {counts.planned ? `${plural(counts.planned, 'move')} in ${plural(batch.albums.filter(album => album.moves.some(move => move.status === 'planned')).length, 'album')}` : 'Nothing to move'}
          </h3>
          <p className="text-[13px] text-muted">
            Previewed {formatRelative(batch.createdAt)}{batch.writeTags ? ' · writes tags' : ''}{batch.includeUnmatched ? ' · includes unidentified music' : ''}{notes.length ? ` · ${notes.join(' · ')}` : ''}
          </p>
        </div>
        {counts.planned > 0 && (
          <Button variant="primary" pending={applying} disabled={selected.size === 0 && selectable.length > 0} onClick={() => void apply()}>
            {!applying && <Check />}{all ? 'Apply all' : `Apply ${plural(selected.size, 'album')}`}
          </Button>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-2 px-1 text-xs text-quiet">
        {defaultTemplate === undefined ? 'Template' : batch.template === defaultTemplate ? 'Default template' : 'This folder’s template'}
        <code className="break-all rounded-md bg-surface px-2 py-0.5 font-mono text-[12px] text-muted">{batch.template}</code>
        <Link to={`/admin/library?edit=${batch.rootId}`} className="font-semibold text-accent hover:underline">Change it in Library</Link>
      </p>
      {counts.planned === 0 && (
        <EmptyState
          className="rounded-2xl bg-sheet ring-1 ring-stroke"
          icon={<FolderTree />}
          title="Everything is in its place"
          description={counts.untrusted && !batch.includeUnmatched ? `${plural(counts.untrusted, 'file')} that ${counts.untrusted === 1 ? 'is' : 'are'} not identified stayed out. Include unidentified music to file them from their tags, or identify them first.` : undefined}
        />
      )}
      {batch.albums.map((album, index) => (
        <AlbumMoves
          key={album.albumId ?? `loose-${index}`}
          album={album}
          checked={album.albumId ? selected.has(album.albumId) : null}
          onCheckedChange={on => album.albumId && toggle(album.albumId, on)}
          onFixMatch={onFixMatch}
          defaultOpen={batch.albums.length <= 6}
        />
      ))}
    </section>
  )
}

function AlbumMoves({ album, checked, onCheckedChange, onFixMatch, defaultOpen }: { album: OrganizeAlbumMoves; checked: boolean | null; onCheckedChange: (on: boolean) => void; onFixMatch: (albumId: string) => void; defaultOpen: boolean }) {
  const planned = album.moves.filter(move => move.status === 'planned')
  const sidecars = planned.filter(move => move.kind === 'sidecar').length
  return (
    <details open={defaultOpen} className="group overflow-hidden rounded-2xl bg-sheet ring-1 ring-stroke">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        {checked !== null && planned.length > 0 && (
          <input
            type="checkbox"
            aria-label={`Apply ${album.title}`}
            checked={checked}
            onChange={event => onCheckedChange(event.target.checked)}
            onClick={event => event.stopPropagation()}
            className="size-4 shrink-0 accent-(--accent)"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold" title={album.title}>{album.title}</span>
          <span className="block truncate text-xs text-muted">
            {[album.artistCredit, planned.length ? plural(planned.length - sidecars, 'file') : 'nothing to move', sidecars && plural(sidecars, 'sidecar')].filter(Boolean).join(' · ')}
          </span>
        </span>
        {album.albumId && (
          <Button size="sm" variant="ghost" onClick={event => { event.preventDefault(); onFixMatch(album.albumId!) }}><Wand2 />Fix match</Button>
        )}
        <ChevronRight aria-hidden className="size-4 shrink-0 text-quiet transition-transform group-open:rotate-90" />
      </summary>
      <ul className="divide-y divide-stroke border-t border-stroke">
        {album.moves.map(move => <MoveRow key={move.id} move={move} />)}
      </ul>
    </details>
  )
}

function MoveRow({ move }: { move: OrganizeMove }) {
  const skipped = move.status === 'skipped' || move.status === 'failed'
  return (
    <li className={cn('flex flex-col gap-1 px-4 py-2.5 font-mono text-[12.5px]', skipped && 'bg-overlay')}>
      <div className="grid gap-1 xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] xl:items-center xl:gap-3">
        <span className="truncate text-muted" title={move.from}>{move.from}</span>
        <ArrowRight aria-label="moves to" className={cn('size-4 max-xl:hidden', skipped ? 'text-quiet' : 'text-accent')} />
        <span className={cn('truncate', skipped && 'text-quiet line-through')} title={move.to}>{move.from === move.to ? 'Tags only, stays in place' : move.to}</span>
      </div>
      {move.reason && <p className={cn('font-sans text-xs', move.status === 'failed' ? 'font-medium text-danger' : 'text-quiet')}>{move.status === 'failed' ? 'Failed: ' : move.status === 'skipped' ? 'Skipped: ' : ''}{move.reason}</p>}
    </li>
  )
}
