import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// The theme's own names from index.css, so a later `rounded-*` or `shadow-*` replaces `rounded-cover` or `shadow-cover`.
const twMerge = extendTailwindMerge({ extend: { theme: { radius: ['cover'], shadow: ['cover'] } } })

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
