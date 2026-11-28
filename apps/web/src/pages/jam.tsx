import { queryKeys } from '@squirmy/contracts'
import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { Link, useParams } from 'react-router'
import { useApi } from '@/api/services'
import { Page } from '@/components/layout/Page'
import { MemberStack } from '@/components/player/ListenTogether'
import { useJoinJam } from '@/components/player/listen-together'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/feedback'
import { usePageTitle } from '@/lib/document-title'

/**
 * `/jam/:id`, where an invite link lands: whose listening session it is and who is in it, and
 * a button to join. Joining asks first because it replaces what this account was playing.
 */
export function JoinJamPage() {
  const { id = '' } = useParams()
  const api = useApi()
  const preview = useQuery({ queryKey: queryKeys.jam(id), queryFn: () => api.sessions.jam(id), retry: false })
  const { join, error, pending, joined, canJam } = useJoinJam(id)
  usePageTitle('Listen together')
  const home = <Button asChild variant="outline"><Link to="/">Go home</Link></Button>
  if (preview.isPending) return <Page><EmptyState icon={<Users />} title="Listen together" description="Looking up this listening session…" headingLevel={1} /></Page>
  if (!preview.data) return <Page><EmptyState icon={<Users />} title="This listening session has ended" description="Ask whoever sent the link to start a new one." headingLevel={1} action={home} /></Page>
  const { hostName, members } = preview.data
  const others = members.length - 1
  return (
    <Page>
      <EmptyState
        icon={<Users />}
        title={`Listen with ${hostName}`}
        description={joined
          ? 'You’re in. What they play plays here too.'
          : `${others > 0 ? `${hostName} and ${others} ${others === 1 ? 'other' : 'others'} are listening.` : `${hostName} is listening.`} Joining replaces what you’re playing, and you’ll hear the same music in step.`}
        headingLevel={1}
        action={(
          <div className="flex flex-col items-center gap-3">
            <MemberStack members={members.map(member => ({ ...member, joinedAt: 0 }))} max={6} />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {!canJam && <p className="text-sm text-muted-foreground">Connecting to the server…</p>}
            <div className="flex gap-2">
              {home}
              {!joined && <Button variant="primary" pending={pending} disabled={!canJam} onClick={() => void join()}>Join</Button>}
            </div>
          </div>
        )}
      />
    </Page>
  )
}
