import { Heart } from 'lucide-react'
import { IconButton, type IconButtonProps } from '@/components/ui/icon-button'
import { librarySave } from '@/lib/catalog'
import { cn } from '@/lib/utils'
import { useLibraryFailure } from '@/player/library-context'

type SaveHeartProps = Omit<IconButtonProps, 'label' | 'onClick' | 'children' | 'failure'> & {
  /** The track, album or artist it saves: a save the server refuses says so beside this heart. */
  id?: string
  liked: boolean
  onToggle: () => void
  /** Names what is saved, for rows where many hearts sit one under another. */
  title?: string
}

/**
 * The heart: the one control that saves a track, album or artist to the library (`liked`). It
 * shows the viewer's own save only, so music on the server has it too, and it is never hidden.
 * It changes at once; when the server refuses, it goes back and says so beside itself for a few
 * seconds ("Couldn’t save. Try again."), and the library tells screen readers which item it was.
 */
export function SaveHeart({ id, liked, onToggle, title, className, ...props }: SaveHeartProps) {
  const { saved, label } = librarySave({ liked })
  const failure = useLibraryFailure(id === undefined ? undefined : `save:${id}`)
  const named = title ? (saved ? `Remove ${title} from library` : `Save ${title} to library`) : label
  return (
    <IconButton label={named} onClick={onToggle} failure={failure} className={cn(saved && 'text-primary hover:text-primary', className)} {...props}>
      <Heart fill={saved ? 'currentColor' : 'none'} />
    </IconButton>
  )
}
