import { CardGrid } from '@/components/music/Cards'
import { Skeleton } from '@/components/ui/feedback'
import { cn } from '@/lib/utils'

/** Placeholders shaped like what is loading, so the page does not jump when it arrives. */

export function CardSkeleton({ round }: { round?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-2', round && 'items-center')}>
      <Skeleton className={cn('aspect-square w-full', round ? 'rounded-full' : 'rounded-cover')} />
      <Skeleton className="mt-1 h-3.5 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  )
}

export function RailSkeleton() {
  return (
    <div aria-hidden className="min-w-0">
      <Skeleton className="mb-4 h-6 w-44" />
      <div className="flex gap-4 overflow-hidden md:gap-5">
        {[0, 1, 2, 3, 4, 5, 6].map(item => <div key={item} className="w-36 shrink-0 sm:w-40 lg:w-44"><CardSkeleton /></div>)}
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
        <div key={row} className="flex h-14 items-center gap-3 px-2">
          {art ? <Skeleton className="size-10 shrink-0 rounded-md" /> : <Skeleton className="h-4 w-6 shrink-0" />}
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-[min(16rem,60%)]" />
            <Skeleton className="h-3 w-[min(9rem,35%)]" />
          </div>
          <Skeleton className="h-3 w-9" />
        </div>
      ))}
    </div>
  )
}

/** The top of an album, artist or playlist page while it loads. */
export function CollectionSkeleton({ round }: { round?: boolean }) {
  return (
    <div role="status" aria-label="Loading" className="px-(--gutter) pt-6 md:pt-8">
      <div className="@container rounded-2xl border border-stroke bg-sheet">
        <div className="flex flex-col items-center gap-5 p-5 @min-[32rem]:flex-row @min-[32rem]:gap-7 @min-[32rem]:p-7">
          <Skeleton className={cn('aspect-square w-[min(51vw,11rem)] shrink-0 @min-[32rem]:w-44 @min-[55rem]:w-52', round ? 'rounded-full' : 'rounded-cover')} />
          <div className="flex w-full flex-col items-center gap-3 @min-[32rem]:items-start">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-12 w-[min(28rem,80%)]" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
      </div>
      <div className="pt-6"><TrackRowsSkeleton /></div>
    </div>
  )
}
