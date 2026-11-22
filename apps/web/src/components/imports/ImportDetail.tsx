import type { Import, ImportAlbum, ImportKind } from '@squirmy/contracts'
import { Check, CircleAlert, CloudDownload, FolderInput, ListChecks, Upload, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Cover } from '@/components/music/Cover'
import { Button } from '@/components/ui/button'
import { Badge, Skeleton, Spinner } from '@/components/ui/feedback'
import { formatBytes, formatRelative, plural } from '@/lib/format'
import { importState, importSteps, isCancelled, kindLabels } from '@/lib/imports'
import { cn } from '@/lib/utils'

const kindIcons: Record<ImportKind, typeof Upload> = { upload: Upload, inbox: FolderInput, acquisition: CloudDownload }

export function ImportKindIcon({ kind, className }: { kind: ImportKind; className?: string }) {
  const Icon = kindIcons[kind]
  return <Icon aria-hidden className={className} />
}

/** Where an import is. Only one still at work wears the action color. */
export function ImportStateBadge({ item }: { item: Import }) {
  const running = item.status === 'receiving' || item.status === 'processing'
  return (
    <Badge tone={running ? 'accent' : isCancelled(item) ? 'outline' : item.status === 'failed' ? 'danger' : 'neutral'}>
      {running && <Spinner label="" className="size-3 text-current" />}
      {item.status === 'completed' && <Check aria-hidden className="text-primary" strokeWidth={2.5} />}
      {importState(item)}
    </Badge>
  )
}

type ImportDetailProps = {
  item: Import
  /** Who started it, for admins looking at someone else's. */
  owner?: string | null
  /** Undefined until loaded; only asked for once the import is done. */
  albums: ImportAlbum[] | undefined
  isAdmin: boolean
  onCancel?: () => void
  /** Below the result: what an upload could not send, say. */
  children?: ReactNode
}

/** One import from start to finish: where it is now, then what came of it. */
export function ImportDetail({ item, owner, albums, isAdmin, onCancel, children }: ImportDetailProps) {
  const { counts } = item
  const done = item.status === 'completed'
  return (
    <div className="flex flex-col gap-6">
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-start gap-3 p-4">
          <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg border', item.status === 'failed' && !isCancelled(item) ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'bg-muted/50 text-muted-foreground')}><ImportKindIcon kind={item.kind} className="size-5" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 truncate text-base font-semibold">{item.label ?? `${kindLabels[item.kind]} import`}</h2>
              <ImportStateBadge item={item} />
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {[kindLabels[item.kind], owner, `started ${formatRelative(item.createdAt)}`, item.completedAt && `finished ${formatRelative(item.completedAt)}`].filter(Boolean).join(' · ')}
            </p>
          </div>
          {item.status === 'receiving' && onCancel && <Button size="sm" variant="outline" onClick={onCancel}><X />Cancel</Button>}
        </div>
        <Steps item={item} />
      </div>

      {item.status === 'failed' && !isCancelled(item) && (
        <p role="alert" className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{item.error ?? 'The import failed.'}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Count label="Received" value={counts.filesReceived} detail={counts.bytesReceived ? formatBytes(counts.bytesReceived) : undefined} />
        <Count label="Duplicates skipped" value={counts.duplicatesSkipped} detail={done ? 'Already in the library' : undefined} pending={!done} />
        <Count label="Albums filed" value={counts.albumsFiled} detail={done ? `${plural(counts.albumsIdentified, 'album')} identified` : undefined} pending={!done} />
        <Count
          label="Left for review"
          value={counts.filesLeftForReview}
          pending={!done}
          detail={done && counts.filesLeftForReview > 0
            ? isAdmin ? <Link to="/admin/reviews" className="rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">Open the review queue</Link> : 'An admin will sort these out'
            : done ? 'Nothing waiting' : undefined}
        />
      </div>

      {(counts.filesRejected > 0 || counts.archivesRejected > 0 || counts.unreadable > 0 || item.timedOut) && (
        <ul className="flex flex-col gap-1.5 rounded-xl border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          {counts.filesRejected > 0 && <li>{plural(counts.filesRejected, 'file')} not taken: not music, or a name the server does not accept.</li>}
          {counts.archivesRejected > 0 && <li>{plural(counts.archivesRejected, 'zip archive')} could not be unpacked safely.</li>}
          {counts.unreadable > 0 && <li>{plural(counts.unreadable, 'file')} could not be read as audio.</li>}
          {item.timedOut && <li>Identification took too long, so what was still waiting was left for review.</li>}
        </ul>
      )}

      {done && <AlbumsOf albums={albums} />}
      {children}
    </div>
  )
}

function Count({ label, value, detail, pending }: { label: string; value: number; detail?: ReactNode; pending?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-1 text-2xl font-semibold tabular tracking-tight', pending && 'text-muted-foreground/60')}>{pending ? '–' : value.toLocaleString()}</p>
      <div className="mt-0.5 min-h-4 text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

function Steps({ item }: { item: Import }) {
  const reached = item.status === 'completed' ? importSteps.length : importSteps.findIndex(step => step.step === (item.step ?? 'receiving'))
  const failed = item.status === 'failed'
  return (
    <ol aria-label="Progress" className="flex flex-wrap gap-x-5 gap-y-2 border-t bg-muted/40 px-4 py-3">
      {importSteps.map((step, index) => {
        const state = index < reached ? 'done' : index === reached && !failed ? 'active' : 'waiting'
        return (
          <li key={step.step} aria-current={state === 'active' ? 'step' : undefined} className={cn('flex items-center gap-1.5 text-xs', state === 'waiting' ? 'text-muted-foreground' : state === 'active' && 'font-medium')}>
            <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full', state === 'done' ? 'bg-primary/12 text-primary' : state === 'waiting' && 'border border-input bg-card')}>
              {state === 'done' ? <Check className="size-3" strokeWidth={3} /> : state === 'active' ? <Spinner label="" className="size-4 text-primary" /> : null}
            </span>
            {state === 'active' ? step.active : step.label}
          </li>
        )
      })}
    </ol>
  )
}

function AlbumsOf({ albums }: { albums: ImportAlbum[] | undefined }) {
  if (!albums) return <Skeleton className="h-32 rounded-xl" />
  if (!albums.length) return null
  return (
    <section aria-labelledby="import-albums">
      <h3 id="import-albums" className="text-sm font-semibold">Albums</h3>
      <ul className="mt-3 divide-y overflow-hidden rounded-xl border bg-card">
        {albums.map(({ album, files, filed }) => (
          <li key={album.id}>
            <Link to={`/album/${album.id}`} className="flex items-center gap-3 px-4 py-2.5 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60">
              <Cover artwork={album.artwork} size={96} className="size-10" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{album.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{album.artistCredit} · {plural(files, 'file')}</span>
              </span>
              {filed
                ? <Badge tone="neutral"><Check className="text-primary" strokeWidth={2.5} />Filed</Badge>
                : <Badge tone="outline"><ListChecks />In review</Badge>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
