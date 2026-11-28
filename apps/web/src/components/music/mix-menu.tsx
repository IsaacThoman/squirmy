import type { MixSummary, PlaylistSummary } from '@squirmy/contracts'
import { ListEnd, ListMusic, ListPlus, ListStart, Play, Plus, Shuffle } from 'lucide-react'
import type { MenuEntry } from '@/components/ui/menu'

/** "Mix 1" of "Mix 1 · Indie, Folk": the slot a mix's cover shows. */
export const mixSlot = (mix: Pick<MixSummary, 'name'>) => mix.name.split(' · ')[0] ?? mix.name

/**
 * What a mix's menu offers, on its page and its card: play it in order or shuffled (on a card;
 * its page has its own Play and Shuffle), queue it, or keep it as a playlist (a mix changes
 * every day; a playlist made of it does not).
 */
export function mixMenuEntries({ onPlay, onShuffle, onEnqueue, playlists, onAddToPlaylist }: {
  onPlay?: () => void
  onShuffle?: () => void
  onEnqueue: (placement: 'next' | 'last') => void | Promise<unknown>
  playlists: PlaylistSummary[]
  onAddToPlaylist: (playlist: PlaylistSummary | null) => void | Promise<unknown>
}): MenuEntry[] {
  return [
    ...(onPlay ? [{ label: 'Play', icon: <Play />, onSelect: onPlay }] : []),
    ...(onShuffle ? [{ label: 'Shuffle', icon: <Shuffle />, onSelect: onShuffle }] : []),
    { label: 'Play next', icon: <ListStart />, onSelect: () => onEnqueue('next'), done: 'Playing next' },
    { label: 'Add to queue', icon: <ListEnd />, onSelect: () => onEnqueue('last'), done: 'Added to queue' },
    {
      kind: 'submenu',
      label: 'Add to playlist',
      icon: <ListPlus />,
      items: [
        { label: 'New playlist…', icon: <Plus />, onSelect: () => onAddToPlaylist(null) },
        ...(playlists.length ? [{ kind: 'separator' as const }] : []),
        ...playlists.map(playlist => ({ label: playlist.name, icon: <ListMusic />, onSelect: () => onAddToPlaylist(playlist), done: `Added to ${playlist.name}` })),
      ],
    },
  ]
}
