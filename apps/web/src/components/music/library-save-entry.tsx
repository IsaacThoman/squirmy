import { Heart } from 'lucide-react'
import type { MenuEntry } from '@/components/ui/menu'
import { librarySave } from '@/lib/catalog'

/** The menu entry that mirrors the heart, worded by client-core's rule: one entry for the one state. */
export function librarySaveEntry(item: { liked: boolean }, onSelect: () => void): MenuEntry {
  const { saved, label } = librarySave(item)
  return { label, icon: <Heart fill={saved ? 'currentColor' : 'none'} />, onSelect }
}
