import type { Import } from '@squirmy/contracts'
import { Inbox, MoreHorizontal } from 'lucide-react'
import { Link } from 'react-router'
import { EmptyState, Skeleton } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu } from '@/components/ui/menu'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { importSummary, isCancelled, kindLabels } from '@/lib/imports'
import { ImportKindIcon, ImportStateBadge } from './ImportDetail'

type ImportsListProps = {
  /** Undefined while loading. */
  imports: Import[] | undefined
  /** Who started an import, by user id; admins see everyone's. */
  ownerOf: (item: Import) => string | null
  onCancel: (item: Import) => void
}

/** Recent imports, newest first, each opening its detail. */
export function ImportsList({ imports, ownerOf, onCancel }: ImportsListProps) {
  if (!imports) return <div className="flex flex-col gap-2">{[0, 1, 2].map(index => <Skeleton key={index} className="h-[72px] rounded-2xl" />)}</div>
  if (!imports.length) return <EmptyState icon={<Inbox />} title="Nothing imported yet" description="Uploads, the inbox folder and music fetched on demand all show up here." className="py-10" />
  return (
    <ul aria-label="Recent imports" className="divide-y divide-stroke overflow-hidden rounded-2xl bg-sheet ring-1 ring-stroke">
      {imports.map(item => {
        const failed = item.status === 'failed' && !isCancelled(item)
        return (
          <li key={item.id} className="group relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-overlay">
            <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', failed ? 'bg-danger/12 text-danger' : 'bg-surface text-muted')}><ImportKindIcon kind={item.kind} className="size-[18px]" /></div>
            <div className="min-w-0 flex-1">
              <Link to={`/imports/${item.id}`} className="block truncate text-[15px] font-semibold after:absolute after:inset-0">{item.label ?? `${kindLabels[item.kind]} import`}</Link>
              <p className="truncate text-[13px] text-muted">
                {[kindLabels[item.kind], ownerOf(item), formatRelative(item.createdAt), failed ? item.error : importSummary(item)].filter(Boolean).join(' · ')}
              </p>
            </div>
            <ImportStateBadge item={item} />
            {item.status === 'receiving' && (
              <DropdownMenu
                entries={[{ label: 'Cancel import', danger: true, onSelect: () => onCancel(item) }]}
                trigger={<IconButton label={`More options for ${item.label ?? 'import'}`} size="sm" className="relative"><MoreHorizontal /></IconButton>}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
