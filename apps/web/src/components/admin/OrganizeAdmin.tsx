import { ORGANIZE_TAGS_NOT_REVERTED, type LibraryRoot, type OrganizeAlbumMoves, type OrganizeBatch, type OrganizeBatchStatus, type OrganizeBatchSummary, type OrganizeMove } from '@squirmy/contracts'
import { ArrowRight, Check, ChevronRight, Eye, FolderTree, Undo2, Wand2 } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { Badge, EmptyState, ProgressBar, Skeleton } from '@/components/ui/feedback'
import { Row, Section } from '@/components/ui/section'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatRelative, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader } from './AdminLayout'
import { cardClass, FolderPath, Panel } from './Panel'

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
    <div>
      <AdminHeader title="Organize" description="Files music in managed folders by what it is. Nothing moves until you apply a preview, and every batch can be undone." />
      <div className="flex flex-col gap-7">
        {roots?.length === 0 && (
          <EmptyState
            className={cardClass}
            icon={<FolderTree />}
            title="No managed folders"
            description="Organize works on folders Squirmy may change. Make one managed from Library: edit the folder and let Squirmy organize it."
            action={<Button asChild variant="primary"><Link to="/admin/library">Go to Library</Link></Button>}
          />
        )}
        {!roots && <Skeleton className="h-48 rounded-xl" />}
        {root && (
          <Section
            title="Folder"
            action={roots!.length > 1 && <Select label="Managed folder" size="sm" value={root.id} onValueChange={onRootChange} options={roots!.map(item => ({ value: item.id, label: item.name }))} />}
          >
            <Row label={root.name} description={<FolderPath path={root.path} />}>
              <Button size="sm" variant={preview && !running ? 'outline' : 'primary'} pending={previewing} disabled={!!running} onClick={() => void requestPreview()}>{!previewing && <Eye />}Preview</Button>
            </Row>
            <Row label="Include unidentified music" description="Also file albums that are not identified, named from their own tags. Off: only identified or approved albums move.">
              <Switch aria-label="Include unidentified music" checked={options.includeUnmatched} onCheckedChange={includeUnmatched => setOptions({ ...options, includeUnmatched })} />
            </Row>
            <Row label="Write tags" description="Write the identified titles, artists and album into the files. Undo moves files back but does not take tags out.">
              <Switch aria-label="Write tags" checked={options.writeTags} onCheckedChange={writeTags => setOptions({ ...options, writeTags })} />
            </Row>
          </Section>
        )}

        {running && <RunningBatch batch={running} />}
        {root && !running && preview && <Preview key={preview.id} batch={preview} defaultTemplate={defaultTemplate} onApply={onApply} onFixMatch={onFixMatch} />}

        {history && history.length > 0 && (
          <Panel title="History">
            <ul className={cn(cardClass, 'divide-y')}>
              {history.map(batch => (
                <li key={batch.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {batch.rootName}<StatusBadge status={batch.status} />{batch.writeTags && <Badge tone="outline">Tags</Badge>}
                    </p>
                    <p className="mt-0.5 text-xs tabular text-muted-foreground">{batchSummary(batch)}</p>
                    <p className="text-xs text-muted-foreground">
                      {batch.revertedAt ? `Undone ${formatRelative(batch.revertedAt)}` : batch.appliedAt ? `Applied ${formatRelative(batch.appliedAt)}` : `Started ${formatRelative(batch.createdAt)}`}
                    </p>
                  </div>
                  {batch.status === 'applied' && <Button size="sm" variant="outline" disabled={!!running} onClick={() => setUndoing(batch)}><Undo2 />Undo</Button>}
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      <ConfirmDialog
        open={!!undoing}
        onOpenChange={open => { if (!open) setUndoing(null) }}
        title="Undo this batch?"
        description={undoing && (
          <>
            {plural(undoing.counts.applied, 'file')} in {undoing.rootName} move back to where they were, and folders the batch created are removed once empty.{' '}
            {undoing.writeTags ? <strong className="font-medium text-foreground">{ORGANIZE_TAGS_NOT_REVERTED}</strong> : 'This batch wrote no tags.'}
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
    <section aria-live="polite" className={cn(cardClass, 'flex flex-col gap-2 p-4')}>
      <p className="text-sm font-medium">{undoing ? 'Undoing' : 'Applying'} a batch in {batch.rootName}</p>
      <ProgressBar value={total ? done / total : null} label={undoing ? 'Undoing' : 'Applying'} />
      <p className="flex justify-between gap-3 text-xs text-muted-foreground">
        <span>{undoing ? 'Moving files back' : 'Moving files'}{counts.failed ? ` · ${counts.failed} failed` : ''}</span>
        <span className="tabular">{done.toLocaleString()} of {total.toLocaleString()}</span>
      </p>
      <p className="text-xs text-muted-foreground">Previews and other batches in this folder wait until it finishes.</p>
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
    <Panel
      aria-label="Preview"
      title={counts.planned ? `${plural(counts.planned, 'move')} in ${plural(batch.albums.filter(album => album.moves.some(move => move.status === 'planned')).length, 'album')}` : 'Nothing to move'}
      description={`Previewed ${formatRelative(batch.createdAt)}${batch.writeTags ? ' · writes tags' : ''}${batch.includeUnmatched ? ' · includes unidentified music' : ''}${notes.length ? ` · ${notes.join(' · ')}` : ''}`}
      action={counts.planned > 0 && (
        <Button size="sm" variant="primary" pending={applying} disabled={selected.size === 0 && selectable.length > 0} onClick={() => void apply()}>
          {!applying && <Check />}{all ? 'Apply all' : `Apply ${plural(selected.size, 'album')}`}
        </Button>
      )}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span>{defaultTemplate === undefined ? 'Template' : batch.template === defaultTemplate ? 'Default template' : 'This folder’s template'}</span>
        <code className="break-all font-mono text-foreground">{batch.template}</code>
        <Link to={`/admin/library?edit=${batch.rootId}`} className="text-primary underline-offset-4 hover:underline sm:ml-auto">Change it in Library</Link>
      </p>
      {counts.planned === 0 && (
        <EmptyState
          className={cardClass}
          icon={<FolderTree />}
          title="Everything is in its place"
          description={counts.untrusted && !batch.includeUnmatched ? `${plural(counts.untrusted, 'file')} that ${counts.untrusted === 1 ? 'is' : 'are'} not identified stayed out. Include unidentified music to file them from their tags, or identify them first.` : undefined}
        />
      )}
      {batch.albums.length > 0 && (
        <div className={cn(cardClass, '@container divide-y overflow-hidden')}>
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
        </div>
      )}
    </Panel>
  )
}

function AlbumMoves({ album, checked, onCheckedChange, onFixMatch, defaultOpen }: { album: OrganizeAlbumMoves; checked: boolean | null; onCheckedChange: (on: boolean) => void; onFixMatch: (albumId: string) => void; defaultOpen: boolean }) {
  const planned = album.moves.filter(move => move.status === 'planned')
  const sidecars = planned.filter(move => move.kind === 'sidecar').length
  return (
    <details open={defaultOpen} className="group">
      <summary className="flex list-none items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/30 [&::-webkit-details-marker]:hidden">
        {checked !== null && planned.length > 0 && (
          <input
            type="checkbox"
            aria-label={`Apply ${album.title}`}
            checked={checked}
            onChange={event => onCheckedChange(event.target.checked)}
            onClick={event => event.stopPropagation()}
            className="size-4 shrink-0 accent-primary"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={album.title}>{album.title}</span>
          <span className="block truncate text-xs tabular text-muted-foreground">
            {[album.artistCredit, planned.length ? plural(planned.length - sidecars, 'file') : 'nothing to move', sidecars && plural(sidecars, 'sidecar')].filter(Boolean).join(' · ')}
          </span>
        </span>
        {album.albumId && (
          <Button size="sm" variant="ghost" onClick={event => { event.preventDefault(); onFixMatch(album.albumId!) }}><Wand2 /><span className="max-sm:sr-only">Fix match</span></Button>
        )}
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
      </summary>
      <ul className="divide-y border-t bg-muted/30">
        {album.moves.map(move => <MoveRow key={move.id} move={move} />)}
      </ul>
    </details>
  )
}

function MoveRow({ move }: { move: OrganizeMove }) {
  const skipped = move.status === 'skipped' || move.status === 'failed'
  return (
    <li className="flex flex-col gap-1 px-4 py-2 font-mono text-xs">
      <div className="grid gap-1 @3xl:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] @3xl:items-center @3xl:gap-3">
        <span className="truncate text-muted-foreground" title={move.from}>{move.from}</span>
        <ArrowRight aria-label="moves to" className={cn('size-3.5 @max-3xl:hidden', skipped ? 'text-muted-foreground' : 'text-primary')} />
        <span className={cn('truncate', skipped && 'text-muted-foreground line-through')} title={move.to}>{move.from === move.to ? 'Tags only, stays in place' : move.to}</span>
      </div>
      {move.reason && <p className={cn('font-sans', move.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>{move.status === 'failed' ? 'Failed: ' : move.status === 'skipped' ? 'Skipped: ' : ''}{move.reason}</p>}
    </li>
  )
}
