import { Heart } from 'lucide-react'
import { IconButton, type IconButtonProps } from '@/components/ui/icon-button'
import { librarySave } from '@/lib/catalog'
import { cn } from '@/lib/utils'

type SaveHeartProps = Omit<IconButtonProps, 'label' | 'onClick' | 'children'> & {
  liked: boolean
  onToggle: () => void
  /** Names what is saved, for rows where many hearts sit one under another. */
  title?: string
}

/**
 * The heart: the one control that saves a track, album or artist to the library (`liked`). It
 * shows the viewer's own save only, so music on the server has it too, and it is never hidden.
 */
export function SaveHeart({ liked, onToggle, title, className, ...props }: SaveHeartProps) {
  const { saved, label } = librarySave({ liked })
  const named = title ? (saved ? `Remove ${title} from library` : `Save ${title} to library`) : label
  return (
    <IconButton label={named} onClick={onToggle} className={cn(saved && 'text-primary hover:text-primary', className)} {...props}>
      <Heart fill={saved ? 'currentColor' : 'none'} />
    </IconButton>
  )
}
