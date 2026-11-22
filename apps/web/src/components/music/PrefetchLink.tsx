import { Link, type LinkProps } from 'react-router'
import { usePrefetch, type PrefetchTarget } from '@/api/prefetch'

/** A link to an album or artist page that starts loading it on hover, focus or press. */
export function PrefetchLink({ kind, id, ...props }: LinkProps & PrefetchTarget) {
  const prefetch = usePrefetch({ kind, id })
  return <Link {...props} {...prefetch} />
}
