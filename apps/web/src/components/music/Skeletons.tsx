import { CardGrid } from '@/components/music/Cards'
import { Skeleton } from '@/components/ui/feedback'
import { cn } from '@/lib/utils'

/** Placeholders shaped like what is loading, so the page does not jump when it arrives. */

export function CardSkeleton({ round }: { round?: boolean }) {
  return (
    <div className={cn('flex flex-col', round && 'items-center')}>
      <Skeleton className={cn('aspect-square w-full', round ? 'rounded-full' : 'rounded-cover')} />
      <Skeleton className="mt-3 h-3 w-3/4" />
      <Skeleton className="mt-2 h-2.5 w-1/2" />
    </div>
  )
}

export function RailSkeleton() {
  return (
    <div aria-hidden className="min-w-0">
      <div className="mb-3 flex h-8 items-center"><Skeleton className="h-4 w-36" /></div>
      <div className="flex gap-4 overflow-hidden">
        {[0, 1, 2, 3, 4, 5, 6, 7].map(item => <div key={item} className="w-36 shrink-0 sm:w-40 lg:w-44 compact:w-32 compact:sm:w-32 compact:lg:w-36"><CardSkeleton /></div>)}
      </div>
    </div>
  )
}

export function GridSkeleton({ round, count = 12 }: { round?: boolean; count?: number }) {
  return (
    <div aria-hidden>
      <CardGrid>{Array.from({ length: count }, (_, item) => <CardSkeleton key={item} round={round} />)}</CardGrid>
    </div>
  )
}

export function TrackRowsSkeleton({ rows = 8, art }: { rows?: number; art?: boolean }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className={cn('flex items-center gap-3', art ? 'h-11 compact:h-9' : 'h-10')}>
          {art ? <Skeleton className="size-8 shrink-0 rounded-[5px] compact:size-7" /> : <div className="flex w-8 shrink-0 justify-center"><Skeleton className="h-3 w-4" /></div>}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-[min(16rem,60%)]" />
            {art && <Skeleton className="h-2.5 w-[min(9rem,35%)]" />}
          </div>
          <Skeleton className="h-3 w-8" />
        </div>
      ))}
    </div>
  )
}

/** The top of an album, artist or playlist page while it loads. */
export function CollectionSkeleton({ round }: { round?: boolean }) {
  return (
    <div role="status" aria-label="Loading">
      <div className="flex flex-col items-center gap-5 px-(--gutter) pb-6 pt-[calc(3rem+var(--breadcrumb-space,0px))] md:flex-row md:items-end md:gap-7 md:pt-[calc(2.5rem+var(--breadcrumb-space,0px))]">
        <Skeleton className={cn('aspect-square w-[min(56vw,13rem)] shrink-0 md:w-48 lg:w-56', round ? 'rounded-full' : 'rounded-cover')} />
        <div className="flex w-full flex-col items-center gap-3 md:items-start md:pb-1">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-10 w-[min(26rem,80%)]" />
          <Skeleton className="h-4 w-40" />
        </div>
      </div>
      <div className="flex items-center justify-center gap-2 px-(--gutter) pb-6 md:justify-start">
        <Skeleton className="size-12 rounded-full" />
        <Skeleton className="size-10" />
        <Skeleton className="size-10" />
      </div>
      <div className="px-(--gutter)"><TrackRowsSkeleton /></div>
    </div>
  )
}
