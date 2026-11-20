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

export function ImportStateBadge({ item }: { item: Import }) {
  const running = item.status === 'receiving' || item.status === 'processing'
  return (
    <Badge tone={item.status === 'failed' && !isCancelled(item) ? 'danger' : item.status === 'completed' ? 'accent' : 'neutral'}>
      {running && <Spinner label="" className="size-3 text-current" />}
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
      <div className="flex items-start gap-4 rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-selection text-accent"><ImportKindIcon kind={item.kind} className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="min-w-0 truncate text-[17px] font-bold">{item.label ?? `${kindLabels[item.kind]} import`}</h2>
            <ImportStateBadge item={item} />
          </div>
          <p className="mt-0.5 text-[13px] text-muted">
            {[kindLabels[item.kind], owner, `started ${formatRelative(item.createdAt)}`, item.completedAt && `finished ${formatRelative(item.completedAt)}`].filter(Boolean).join(' · ')}
          </p>
          <Steps item={item} />
        </div>
        {item.status === 'receiving' && onCancel && <Button size="sm" variant="ghost" onClick={onCancel}><X />Cancel</Button>}
      </div>

      {item.status === 'failed' && !isCancelled(item) && (
        <p role="alert" className="flex items-start gap-2.5 rounded-2xl bg-danger/10 px-4 py-3 text-sm font-medium text-danger">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{item.error ?? 'The import failed.'}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Count label="Received" value={counts.filesReceived} detail={counts.bytesReceived ? formatBytes(counts.bytesReceived) : undefined} />
        <Count label="Duplicates skipped" value={counts.duplicatesSkipped} detail={done ? 'Already in the library' : undefined} pending={!done} />
        <Count label="Albums filed" value={counts.albumsFiled} detail={done ? `${plural(counts.albumsIdentified, 'album')} identified` : undefined} pending={!done} />
        <Count
          label="Left for review"
          value={counts.filesLeftForReview}
          pending={!done}
          detail={done && counts.filesLeftForReview > 0
            ? isAdmin ? <Link to="/admin/reviews" className="text-accent hover:underline">Open the review queue</Link> : 'An admin will sort these out'
            : done ? 'Nothing waiting' : undefined}
        />
      </div>

      {(counts.filesRejected > 0 || counts.archivesRejected > 0 || counts.unreadable > 0 || item.timedOut) && (
        <ul className="flex flex-col gap-1.5 rounded-2xl bg-surface px-4 py-3 text-[13px] text-muted">
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
    <div className="rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className={cn('mt-1 text-2xl font-bold tabular tracking-tight', pending && 'text-quiet')}>{pending ? '–' : value.toLocaleString()}</p>
      {detail && <div className="mt-0.5 text-xs text-quiet">{detail}</div>}
    </div>
  )
}

function Steps({ item }: { item: Import }) {
  const reached = item.status === 'completed' ? importSteps.length : importSteps.findIndex(step => step.step === (item.step ?? 'receiving'))
  const failed = item.status === 'failed'
  return (
    <ol aria-label="Progress" className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {importSteps.map((step, index) => {
        const state = index < reached ? 'done' : index === reached && !failed ? 'active' : 'waiting'
        return (
          <li key={step.step} aria-current={state === 'active' ? 'step' : undefined} className={cn('flex items-center gap-1.5 text-xs font-semibold', state === 'waiting' ? 'text-quiet' : state === 'active' ? 'text-accent' : 'text-foreground')}>
            <span className={cn('flex size-4 items-center justify-center rounded-full', state === 'done' ? 'bg-accent text-on-accent' : state === 'waiting' && 'ring-1 ring-stroke ring-inset')}>
              {state === 'done' ? <Check className="size-3" strokeWidth={3} /> : state === 'active' ? <Spinner label="" className="size-4" /> : null}
            </span>
            {state === 'active' ? step.active : step.label}
          </li>
        )
      })}
    </ol>
  )
}

function AlbumsOf({ albums }: { albums: ImportAlbum[] | undefined }) {
  if (!albums) return <Skeleton className="h-36 rounded-2xl" />
  if (!albums.length) return null
  return (
    <section aria-labelledby="import-albums" className="flex flex-col gap-3">
      <h3 id="import-albums" className="px-1 text-lg font-bold tracking-tight">Albums</h3>
      <ul className="divide-y divide-stroke overflow-hidden rounded-2xl bg-sheet ring-1 ring-stroke">
        {albums.map(({ album, files, filed }) => (
          <li key={album.id}>
            <Link to={`/album/${album.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-overlay">
              <Cover artwork={album.artwork} size={96} className="size-11 shrink-0 rounded-md" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold">{album.title}</span>
                <span className="block truncate text-[13px] text-muted">{album.artistCredit} · {plural(files, 'file')}</span>
              </span>
              {filed
                ? <Badge tone="accent"><Check />Filed</Badge>
                : <Badge tone="neutral"><ListChecks />In review</Badge>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
