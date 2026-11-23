import { CircleAlert } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Row } from '@/components/ui/section'
import { cn } from '@/lib/utils'
import { useNote, type Note } from './note'

/** The surface admin pages put their content on. */
export const cardClass = 'rounded-xl border bg-card'

type PanelProps = Omit<ComponentProps<'section'>, 'title'> & {
  title: ReactNode
  description?: ReactNode
  /** Controls beside the title, such as a filter or the part's main action. */
  action?: ReactNode
}

/** A titled part of an admin page whose content is not a card of rows (that is a `Section`): a table, a list, a form. */
export function Panel({ title, description, action, className, children, ...props }: PanelProps) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', className)} {...props}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {description && <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">{description}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  )
}

/** A compact table on a card. It scrolls sideways when its columns do not fit. */
export function DataTable({ className, children, ...props }: ComponentProps<'table'>) {
  return (
    <div className={cn(cardClass, 'overflow-x-auto')}>
      <table className={cn('w-full text-left text-sm', className)} {...props}>{children}</table>
    </div>
  )
}

export function Th({ className, ...props }: ComponentProps<'th'>) {
  return <th scope="col" className={cn('whitespace-nowrap px-3 py-2 text-xs font-normal text-muted-foreground first:pl-4 last:pr-4', className)} {...props} />
}

/** A row of a table's body. */
export function Tr({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('border-b transition-colors last:border-0 hover:bg-muted/30', className)} {...props} />
}

export function Td({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-3 py-2 first:pl-4 last:pr-4', className)} {...props} />
}

/** Options in a dialog, as rows on one bordered card. */
export function OptionGroup({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('divide-y rounded-lg border', className)} {...props} />
}

/** One option of an `OptionGroup`: what it is on the left and a small control on the right, on one line at any width. */
export function OptionRow({ label, description, children }: { label: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** A folder's path. A long one keeps its end, since the last folders are what tell paths apart. */
export function FolderPath({ path, className }: { path: string; className?: string }) {
  return <p dir="rtl" className={cn('truncate text-left font-mono text-xs text-muted-foreground', className)} title={path}><bdi>{path}</bdi></p>
}

/**
 * A note in place, under the row or panel that started the action. The polite live region stays
 * mounted while empty, so a screen reader announces what appears in it; it takes no room then.
 */
export function InlineNote({ note, className }: { note: Note | null; className?: string }) {
  return (
    <div role="status" className="contents">
      {note && (
        <p data-tone={note.tone} className={cn('flex items-start gap-1.5 text-xs', note.tone === 'error' ? 'text-destructive' : 'text-muted-foreground', className)}>
          {note.tone === 'error' && <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />}
          <span className="min-w-0 wrap-anywhere">{note.text}</span>
        </p>
      )}
    </div>
  )
}

type SettingRowProps = Omit<ComponentProps<typeof Row>, 'children'> & {
  /** The control; it saves with `save`, which answers once the server did. */
  children: (save: (work: () => Promise<unknown>) => Promise<unknown>) => ReactNode
}

/**
 * A setting saved as soon as it changes (a switch, a select). The control shows what is saved;
 * a change the server refused leaves it as it was and says why under the setting's label.
 */
export function SettingRow({ description, children, ...props }: SettingRowProps) {
  const { note, run } = useNote()
  return <Row {...props} description={<>{description}<InlineNote note={note} className="mt-1" /></>}>{children(work => run(work))}</Row>
}
