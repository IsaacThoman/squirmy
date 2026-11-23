import type { Import } from '@squirmy/contracts'
import { Inbox, MoreHorizontal } from 'lucide-react'
import { Link } from 'react-router'
import { useNote } from '@/components/admin/note'
import { InlineNote } from '@/components/admin/Panel'
import { EmptyState, Skeleton } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu } from '@/components/ui/menu'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { importSummary, isCancelled, kindLabels } from '@/lib/imports'
import { CANCELLED_NOTE, ImportKindIcon, ImportStateBadge } from './ImportDetail'

type ImportsListProps = {
  /** Undefined while loading. */
  imports: Import[] | undefined
  /** Who started an import, by user id; admins see everyone's. */
  ownerOf: (item: Import) => string | null
  onCancel: (item: Import) => Promise<unknown>
}

/** Recent imports, newest first, each opening its detail. */
export function ImportsList({ imports, ownerOf, onCancel }: ImportsListProps) {
  if (!imports) {
    return (
      <div className="divide-y rounded-xl border bg-card">
        {[0, 1, 2].map(index => (
          <div key={index} className="flex items-center gap-3 px-4 py-2.5">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex flex-1 flex-col gap-1.5 py-0.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-64 max-w-full" /></div>
          </div>
        ))}
      </div>
    )
  }
  if (!imports.length) return <EmptyState icon={<Inbox />} title="Nothing imported yet" description="Uploads and music from the inbox folder show up here." className="rounded-xl border py-10" />
  return (
    <ul aria-label="Recent imports" className="divide-y overflow-hidden rounded-xl border bg-card">
      {imports.map(item => <ImportRow key={item.id} item={item} owner={ownerOf(item)} onCancel={() => onCancel(item)} />)}
    </ul>
  )
}

/** One import, with what cancelling it came to under its summary. */
function ImportRow({ item, owner, onCancel }: { item: Import; owner: string | null; onCancel: () => Promise<unknown> }) {
  const { note, run } = useNote()
  const failed = item.status === 'failed' && !isCancelled(item)
  return (
    // The fill alone is too faint to find the keyboard on; the link's own ring marks focus.
    <li className="group relative flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/60 has-[a:focus-visible]:bg-accent/60">
      <div className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg border', failed ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'bg-muted/50 text-muted-foreground')}><ImportKindIcon kind={item.kind} className="size-4" /></div>
      <div className="min-w-0 flex-1">
        <Link to={`/imports/${item.id}`} className="block truncate text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring">{item.label ?? `${kindLabels[item.kind]} import`}</Link>
        <p className="truncate text-xs text-muted-foreground">
          {[kindLabels[item.kind], owner, formatRelative(item.createdAt), failed ? item.error : importSummary(item)].filter(Boolean).join(' · ')}
        </p>
        <InlineNote note={note} className="mt-0.5" />
      </div>
      <ImportStateBadge item={item} />
      {item.status === 'receiving' && (
        <DropdownMenu
          entries={[{ label: 'Cancel import', danger: true, onSelect: () => void run(onCancel, () => CANCELLED_NOTE) }]}
          trigger={<IconButton label={`More options for ${item.label ?? 'import'}`} size="sm" className="relative"><MoreHorizontal /></IconButton>}
        />
      )}
    </li>
  )
}
