import { PairingUserCode, type PairingDeviceKind } from '@squirmy/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useApi } from '@/api/services'
import { useMe } from '@/auth/session'
import { AuthFrame } from '@/components/auth/AuthViews'
import { Button } from '@/components/ui/button'
import { FormError, Field, Input } from '@/components/ui/input'
import { usePageTitle } from '@/lib/document-title'

export function PairPage() {
  const { data: user } = useMe()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  usePageTitle('Sign in a TV or speaker')
  const raw = params.get('code') ?? ''
  const code = PairingUserCode.safeParse(raw).data
  if (!user) return (
    <AuthFrame title="Sign in a TV or speaker" description="Use your Squirmy account to approve the sign-in.">
      <div className="space-y-3">
        {code && <Button asChild variant="primary" className="w-full">
          <a href={`squirmy://pair?code=${code}&server=${encodeURIComponent(window.location.origin)}`}>Open in Squirmy for iOS</a>
        </Button>}
        <Button asChild variant={code ? 'outline' : 'primary'} className="w-full">
          <Link to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}>Sign in in browser</Link>
        </Button>
      </div>
    </AuthFrame>
  )
  if (code) return <ConfirmPairing key={`${user.id}:${code}`} code={code} account={user.displayName ?? user.username} />
  return <PairingCode key={raw} initial={raw} onCode={value => setParams({ code: value }, { replace: true })} />
}

function PairingCode({ initial, onCode }: { initial: string; onCode: (code: string) => void }) {
  const [input, setInput] = useState(initial)
  const [error, setError] = useState('')
  return (
    <AuthFrame title="Sign in a TV or speaker" description="Enter the code your Apple TV shows, or the one in your Squirmy speaker’s log and status page.">
      <form className="space-y-4" onSubmit={event => {
        event.preventDefault()
        const parsed = PairingUserCode.safeParse(input)
        if (parsed.success) onCode(parsed.data)
        else setError('Enter the eight characters the TV or speaker shows.')
      }}>
        <Field label="Code" htmlFor="tv-code" error={error}>
          <Input id="tv-code" value={input} maxLength={9} autoCapitalize="characters" autoComplete="off" spellCheck={false}
            onChange={event => { setInput(event.target.value); setError('') }} />
        </Field>
        <Button variant="primary" className="w-full" type="submit">Continue</Button>
      </form>
    </AuthFrame>
  )
}

/** How the approval names the device asking to sign in. */
const kinds: Record<PairingDeviceKind, { noun: string; Noun: string; device: string; shows: string; done: string }> = {
  tv: { noun: 'TV', Noun: 'TV', device: 'This Apple TV', shows: 'the one on your TV', done: 'Your Apple TV will finish signing in automatically.' },
  speaker: {
    noun: 'speaker', Noun: 'Speaker', device: 'This speaker', shows: 'the one in the speaker’s log or status page',
    done: 'Your speaker will finish signing in by itself, then shows up in every device list.',
  },
}

function ConfirmPairing({ code, account }: { code: string; account: string }) {
  const api = useApi()
  const preview = useQuery({
    queryKey: ['tv-pairing', code],
    queryFn: () => api.auth.lookupTvPairing({ code }),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
  const approve = useMutation({ mutationFn: (id: string) => api.auth.approveTvPairing({ id, code }) })
  const device = preview.data
  const kind = kinds[device?.deviceKind ?? 'tv']
  if (approve.isSuccess) return (
    <AuthFrame title={`${kind.Noun} approved`} description={kind.done}>
      <Button asChild variant="primary" className="w-full"><Link to="/">Done</Link></Button>
    </AuthFrame>
  )
  return (
    <AuthFrame title={device ? `Sign in ${device.deviceName}?` : 'Sign in a TV or speaker'}
      description={device ? `${kind.device} will be signed in as ${account}. Approve only if this code matches ${kind.shows}.` : undefined}>
      <div className="space-y-4">
        {preview.isPending && <p role="status" className="text-sm text-muted-foreground">Looking up the code…</p>}
        {device && (
          <dl className="rounded-lg border bg-muted/40 p-3 text-sm">
            <div className="flex justify-between gap-2"><dt>{kind.Noun} code</dt><dd className="font-mono">{code.slice(0, 4)}-{code.slice(4)}</dd></div>
            <div className="flex justify-between gap-2"><dt>IP address</dt><dd className="break-all text-right">{device.ipAddress}</dd></div>
          </dl>
        )}
        {(preview.error ?? approve.error) && <FormError message={errorMessage(preview.error ?? approve.error)} />}
        {device && <Button variant="primary" className="w-full" pending={approve.isPending} onClick={() => approve.mutate(device.id)}>Approve {kind.noun}</Button>}
        <Button asChild variant="outline" className="w-full"><Link to="/pair">Enter another code</Link></Button>
      </div>
    </AuthFrame>
  )
}
