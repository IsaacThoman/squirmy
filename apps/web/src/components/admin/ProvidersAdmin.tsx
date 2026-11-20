import { PlugZap, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge, EmptyState } from '@/components/ui/feedback'
import { Switch } from '@/components/ui/switch'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader } from './AdminLayout'

/** The acquisition contracts are not written yet; this is what the providers page shows. */
export type ProviderItem = { id: string; name: string; url: string; enabled: boolean; status: string; formats: string[]; lastCheck: string | null }

export function ProvidersAdmin({ providers, onToggle, onRegister }: { providers: ProviderItem[]; onToggle: (id: string, enabled: boolean) => void; onRegister: () => void }) {
  return (
    <div>
      <AdminHeader title="Providers" description="Separate services that can supply music you don't have. Off by default; nothing is fetched unless a provider is registered and enabled.">
        <Button variant="primary" onClick={onRegister}><Plus />Register provider</Button>
      </AdminHeader>
      {providers.length === 0 && <EmptyState icon={<PlugZap />} title="No providers" description="Register one by URL and shared secret." />}
      <ul className="grid gap-3 xl:grid-cols-2">
        {providers.map(provider => (
          <li key={provider.id} className="flex items-start gap-4 rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
            <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', provider.enabled ? 'bg-selection text-accent' : 'bg-surface text-quiet')}><PlugZap className="size-5" /></div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h3 className="text-[15px] font-bold">{provider.name}</h3>
                <span className={cn('size-2 rounded-full', provider.status === 'healthy' ? 'bg-accent' : 'bg-stroke')} aria-hidden />
                <span className="text-xs capitalize text-muted">{provider.status}</span>
              </div>
              <p className="truncate font-mono text-xs text-muted">{provider.url}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {provider.formats.map(format => <Badge key={format} tone="outline">{format}</Badge>)}
                {provider.lastCheck && <span className="text-xs text-quiet">checked {formatRelative(provider.lastCheck)}</span>}
              </div>
            </div>
            <Switch aria-label={`Enable ${provider.name}`} checked={provider.enabled} onCheckedChange={enabled => onToggle(provider.id, enabled)} />
          </li>
        ))}
      </ul>
    </div>
  )
}
