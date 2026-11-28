import type { ShareKind, ShareLink } from '@squirmy/contracts'
import { formatDate, formatRelative, plural } from '@/lib/format'

const kindLabels: Record<ShareKind, string> = { album: 'Album', playlist: 'Playlist', track: 'Song' }

/** `Album · Mira Vale · Expires in 6 days · Opened 4 times`, for a link's row. */
export function shareLinkDetail(link: ShareLink, now = Date.now()): string {
  const expiry = link.expiresAt === null ? 'Never expires'
    : link.expired ? `Expired ${formatDate(link.expiresAt)}`
    : `Expires ${formatRelative(link.expiresAt, now)}`
  const opened = link.openCount === 0 ? 'Not opened yet' : `Opened ${plural(link.openCount, 'time')}${link.lastOpenedAt ? `, last ${formatRelative(link.lastOpenedAt, now)}` : ''}`
  return [kindLabels[link.kind], link.subtitle, `Created ${formatDate(link.createdAt)}`, expiry, opened].filter(Boolean).join(' · ')
}
