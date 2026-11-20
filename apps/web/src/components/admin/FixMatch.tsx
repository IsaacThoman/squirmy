import { lazy, Suspense } from 'react'
import type { FixMatchProps } from './FixMatchDialog'

const FixMatchDialog = lazy(() => import('./FixMatchDialog'))

/**
 * "Fix match" for an album, for admins: render it while the dialog should be open. Its code
 * loads on first use, so the album page can offer it without carrying the admin screens.
 *
 *   {fixing && <FixMatch albumId={album.id} onOpenChange={setFixing} onDone={result => …} />}
 */
export function FixMatch(props: FixMatchProps) {
  return <Suspense fallback={null}><FixMatchDialog {...props} /></Suspense>
}
