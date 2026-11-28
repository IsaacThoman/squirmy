import { MoreHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'
import { IconButton, type IconButtonProps } from '@/components/ui/icon-button'
import { ContextMenu, DropdownMenu } from '@/components/ui/menu'
import { useSongMenuEntries, type SongMenuOptions } from './use-song-menu'

type SongMenuButtonProps = SongMenuOptions & {
  size?: IconButtonProps['size']
  className?: string
}

export function SongMenuButton({ size = 'sm', className, ...options }: SongMenuButtonProps) {
  const entries = useSongMenuEntries(options)
  return (
    <DropdownMenu
      entries={entries()}
      trigger={<IconButton label={`More options for ${options.track.title}`} tooltip={false} size={size} className={className}><MoreHorizontal /></IconButton>}
    />
  )
}

/** The same menu from a right-click (or a long press) on what shows the song: the player's artwork and title. */
export function SongContextMenu({ children, ...options }: SongMenuOptions & { children: ReactNode }) {
  const entries = useSongMenuEntries(options)
  return <ContextMenu entries={entries()}>{children}</ContextMenu>
}
