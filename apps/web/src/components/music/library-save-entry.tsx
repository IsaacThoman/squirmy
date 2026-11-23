import { BookmarkCheck, BookmarkPlus, Heart } from 'lucide-react'
import type { MenuItem } from '@/components/ui/menu'
import { librarySave } from '@/lib/catalog'

/**
 * The menu entry that mirrors the heart, worded by client-core's rule: one entry for the one
 * state. It waits for the server when given a promise, and says it worked, since the heart it
 * mirrors may not be in sight.
 */
export function librarySaveEntry(item: { liked: boolean }, onSelect: () => void | Promise<unknown>): MenuItem {
  const { saved, label } = librarySave(item)
  return { label, icon: <Heart fill={saved ? 'currentColor' : 'none'} />, onSelect, done: saved ? 'Removed from library' : 'Saved to library' }
}

/** The Wantlist's entry, for music that does not play: as the heart's, it says it worked. */
export function wantEntry(wanted: boolean, onSelect: () => void | Promise<unknown>): MenuItem {
  return {
    label: wanted ? 'Remove from Wantlist' : 'Add to Wantlist',
    icon: wanted ? <BookmarkCheck /> : <BookmarkPlus />,
    onSelect,
    done: wanted ? 'Removed from Wantlist' : 'Added to Wantlist',
  }
}
