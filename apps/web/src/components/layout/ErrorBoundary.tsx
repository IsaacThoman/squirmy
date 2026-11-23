import { CloudOff, TriangleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { usePageTitle } from '@/lib/document-title'
import { cn } from '@/lib/utils'

/**
 * A part of the app that failed to download: after a new version is deployed, an open tab asks
 * for files that no longer exist. Reloading fetches the new version; retrying in place cannot,
 * because a lazy component keeps its failed import.
 */
function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'ChunkLoadError'
    || /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(error.message)
}

type ErrorBoundaryProps = {
  children: ReactNode
  /** When it changes, a shown error is dropped and the children render again (another page, say). */
  resetKey?: unknown
  /**
   * What shows instead of the children; by default a message with a way to try again, which
   * stands for the whole page: its heading is the page's title, and it names the tab.
   */
  fallback?: (props: { error: unknown; retry: () => void }) => ReactNode
  className?: string
}

type ErrorBoundaryState = { error: unknown; failed: boolean; resetKey: unknown }

/** Keeps an error in one part of the app from blanking the rest of it. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, failed: false, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error, failed: true }
  }

  static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): Partial<ErrorBoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { error: null, failed: false, resetKey: props.resetKey }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Development builds log it already; a production console otherwise shows nothing useful.
    if (!import.meta.env.DEV) console.error(error, info.componentStack)
  }

  retry = () => this.setState({ error: null, failed: false })

  render() {
    const { error, failed } = this.state
    if (!failed) return this.props.children
    if (this.props.fallback) return this.props.fallback({ error, retry: this.retry })
    return <PageError error={error} onRetry={this.retry} className={this.props.className} />
  }
}

/** A page that failed in place of the page: its heading is the page's, and the tab is named for it. */
function PageError(props: { error: unknown; onRetry: () => void; className?: string }) {
  usePageTitle('Page did not load')
  return <ErrorMessage {...props} headingLevel={1} />
}

/** What a failed part of the app shows: reload for a missing download, try again for anything else. */
export function ErrorMessage({ error, onRetry, className, headingLevel }: { error: unknown; onRetry: () => void; className?: string; headingLevel?: 1 | 2 | 3 }) {
  const missing = isChunkLoadError(error)
  return (
    <EmptyState
      className={cn('py-20', className)}
      headingLevel={headingLevel}
      icon={missing ? <CloudOff /> : <TriangleAlert />}
      title={missing ? 'This part of Squirmy could not be loaded' : 'Something went wrong'}
      description={missing ? 'Squirmy may have been updated, or the connection dropped. Reload to get the latest version.' : 'This part of Squirmy hit an error. Try again, or reload the page if it keeps happening.'}
      action={(
        <div className="flex gap-2">
          {!missing && <Button variant="outline" onClick={onRetry}>Try again</Button>}
          <Button variant={missing ? 'primary' : 'secondary'} onClick={() => window.location.reload()}>Reload</Button>
        </div>
      )}
    />
  )
}
