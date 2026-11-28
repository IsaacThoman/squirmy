import type { ShareKind, ShareLink } from '@squirmy/contracts'
import { Disc3, ListMusic, Music } from 'lucide-react'
import { Badge } from '@/components/ui/feedback'

const kindIcons: Record<ShareKind, typeof Disc3> = { album: Disc3, playlist: ListMusic, track: Music }

/** What a link points at, with an icon for its kind and a badge once it has expired. */
export function ShareLinkLabel({ link }: { link: ShareLink }) {
  const Icon = kindIcons[link.kind]
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{link.title}</span>
      {link.expired && <Badge tone="neutral">Expired</Badge>}
    </span>
  )
}
