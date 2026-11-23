import {
  AcquisitionJobStatus, CreateAcquisitionProviderRequest, UpdateAcquisitionPolicy, UpdateAcquisitionProviderRequest,
  type AcquisitionJob, type AcquisitionPolicy, type AcquisitionProvider, type AcquisitionUsage, type LibraryRoot,
} from '@squirmy/contracts'
import { CircleAlert, CircleCheck, CircleSlash, HardDrive, History, MoreHorizontal, Pencil, PlugZap, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { z } from 'zod'
import { useFormSubmit } from '@/api/errors'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog, DialogContent } from '@/components/ui/dialog'
import { Badge, EmptyState, ProgressBar, Skeleton, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input } from '@/components/ui/input'
import { DropdownMenu } from '@/components/ui/menu'
import { Row, Section } from '@/components/ui/section'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatBytes, formatClock, formatRelative, inGigabytes, inMegabytes, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader, DialogForm, Stat } from './AdminLayout'
import { DraftField, type SavePatch } from './DraftField'
import { cardClass, Panel } from './Panel'

type ProvidersAdminProps = {
  /** Undefined while loading. */
  providers: AcquisitionProvider[] | undefined
  policy: AcquisitionPolicy | undefined
  /** What fetched music takes on disk, against the cache limit. Undefined while loading. */
  usage: AcquisitionUsage | undefined
  /** Managed library folders fetched music is kept in (under `_Fetched/`). */
  managedRoots: LibraryRoot[] | undefined
  jobs: AcquisitionJob[] | undefined
  /** There are older requests than those listed: `load` asks for the next page. */
  moreJobs?: MoreJobs
  jobStatus: AcquisitionJobStatus | null
  onJobStatusChange: (status: AcquisitionJobStatus | null) => void
  onCreate: (request: z.input<typeof CreateAcquisitionProviderRequest>) => Promise<unknown>
  onUpdate: (providerId: string, patch: UpdateAcquisitionProviderRequest) => Promise<unknown>
  onDelete: (providerId: string) => Promise<unknown>
  /** Asks the provider for its capabilities; resolves to the provider as it answered. */
  onTest: (providerId: string) => Promise<AcquisitionProvider>
  /** Asks the provider again for every track it could not supply ("Retry unavailable tracks"). */
  onClearMisses: (providerId: string) => Promise<unknown>
  onSavePolicy: SavePatch<UpdateAcquisitionPolicy>
  /** Said in place of each part whose first read failed; the parts that loaded stay usable. */
  failures?: Partial<Record<'providers' | 'policy' | 'usage' | 'jobs', ReactNode>>
}

type MoreJobs = { load: () => void; loading: boolean; failed: boolean }

type ProviderDialog = { kind: 'add' } | { kind: 'edit' | 'delete'; provider: AcquisitionProvider }

const coverageLabels = { assume_available: 'Offers everything', must_resolve: 'Checks each track' } as const

/** Acquisition providers: the services that can supply missing music, how they are used, and what they were asked for. */
export function ProvidersAdmin({ providers, policy, usage, managedRoots, jobs, moreJobs, jobStatus, onJobStatusChange, onCreate, onUpdate, onDelete, onTest, onClearMisses, onSavePolicy, failures }: ProvidersAdminProps) {
  const [dialog, setDialog] = useState<ProviderDialog | null>(null)
  const close = (open: boolean) => { if (!open) setDialog(null) }
  return (
    <div>
      <AdminHeader
        title="Providers"
        description="A provider is a separate service you run that can supply music this server does not have. With one connected, missing songs play on demand. What it delivers is kept as a cache, apart from your own music: it is not added to anyone’s library, and the least recently played files make room once the cache reaches its limit. Until you add one, nothing is ever fetched."
      >
        <Button size="sm" variant="primary" onClick={() => setDialog({ kind: 'add' })}><Plus />Add provider</Button>
      </AdminHeader>

      <div className="flex flex-col gap-7">
        <section aria-label="Providers">
          {!providers && (failures?.providers ?? <Skeleton className="h-24 rounded-xl" />)}
          {providers?.length === 0 && (
            <EmptyState
              className={cn(cardClass, 'py-10')}
              icon={<PlugZap />}
              title="No providers"
              description="On-demand fetching is off. Add a provider by its address and the shared secret you gave it."
              action={<Button variant="outline" onClick={() => setDialog({ kind: 'add' })}><Plus />Add provider</Button>}
            />
          )}
          {providers && providers.length > 0 && (
            <ul className={cn(cardClass, 'divide-y')}>
              {providers.map(provider => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  onToggle={enabled => void onUpdate(provider.id, { enabled }).catch(() => {})}
                  onTest={() => onTest(provider.id)}
                  onClearMisses={() => onClearMisses(provider.id)}
                  onEdit={() => setDialog({ kind: 'edit', provider })}
                  onDelete={() => setDialog({ kind: 'delete', provider })}
                />
              ))}
            </ul>
          )}
        </section>

        <CacheUsage usage={usage} failure={failures?.usage} />
        <PolicySettings policy={policy} managedRoots={managedRoots} onSave={onSavePolicy} failure={failures?.policy} />
        <JobsList jobs={jobs} more={moreJobs} status={jobStatus} onStatusChange={onJobStatusChange} failure={failures?.jobs} />
      </div>

      <ProviderFormDialog open={dialog?.kind === 'add'} onOpenChange={close} onAdd={onCreate} />
      {dialog?.kind === 'edit' && <ProviderFormDialog open provider={dialog.provider} onOpenChange={close} onSave={patch => onUpdate(dialog.provider.id, patch)} />}
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={close}
        title={dialog?.kind === 'delete' ? `Delete ${dialog.provider.name}?` : ''}
        description="The server stops asking it for music. Music it already supplied stays in the cache until it makes room for newer songs."
        confirmLabel="Delete provider"
        onConfirm={() => dialog?.kind === 'delete' ? onDelete(dialog.provider.id) : Promise.resolve()}
      />
    </div>
  )
}

type TestResult = { ok: true; provider: AcquisitionProvider } | { ok: false; message: string }

type ProviderRowProps = {
  provider: AcquisitionProvider
  onToggle: (enabled: boolean) => void
  onTest: () => Promise<AcquisitionProvider>
  onClearMisses: () => Promise<unknown>
  onEdit: () => void
  onDelete: () => void
}

function ProviderRow({ provider, onToggle, onTest, onClearMisses, onEdit, onDelete }: ProviderRowProps) {
  const [testing, setTesting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const retry = async () => {
    setRetrying(true)
    try {
      await onClearMisses()
    } catch {
      // The page reports the failure.
    } finally {
      setRetrying(false)
    }
  }
  const unavailable = provider.unavailableTracks
  const [result, setResult] = useState<TestResult | null>(null)
  const test = async () => {
    setTesting(true)
    try {
      const tested = await onTest()
      setResult(tested.lastError ? { ok: false, message: tested.lastError } : { ok: true, provider: tested })
    } catch {
      setResult(null)
    } finally {
      setTesting(false)
    }
  }
  const capabilities = provider.capabilities
  return (
    <li aria-label={provider.name} className="flex flex-col gap-3 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className={cn('mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground', !provider.enabled && 'opacity-50')}><PlugZap className="size-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium">{provider.name}</h3>
            {provider.enabled ? <Badge tone="accent">Enabled</Badge> : <Badge>Disabled</Badge>}
            <Badge tone="outline">{coverageLabels[provider.coverage]}</Badge>
            {provider.priority !== 0 && <Badge tone="outline" className="tabular">Priority {provider.priority}</Badge>}
            {provider.failingSince && <Badge tone="danger"><CircleAlert aria-hidden />Failing</Badge>}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={provider.baseUrl}>{provider.baseUrl}</p>
          {!provider.failingSince && <p className={cn('mt-1 text-xs', provider.lastError ? 'text-destructive' : 'text-muted-foreground')}>
            {provider.lastError
              ? `Last error: ${provider.lastError}`
              : provider.lastOkAt ? `Answered ${formatRelative(provider.lastOkAt)}` : 'Has not answered yet'}
            {provider.lastError && provider.lastOkAt && <span className="text-muted-foreground"> · last answered {formatRelative(provider.lastOkAt)}</span>}
          </p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch aria-label={`Enable ${provider.name}`} checked={provider.enabled} onCheckedChange={onToggle} className="mr-2" />
          <Button size="sm" variant="outline" className="max-sm:hidden" pending={testing} onClick={() => void test()}>{!testing && <RefreshCw />}Test connection</Button>
          <DropdownMenu
            entries={[
              { label: 'Test connection', icon: <RefreshCw />, onSelect: () => void test() },
              { label: 'Edit…', icon: <Pencil />, onSelect: onEdit },
              { kind: 'separator' },
              { label: 'Delete provider…', icon: <Trash2 />, danger: true, onSelect: onDelete },
            ]}
            trigger={<IconButton label={`More options for ${provider.name}`} size="sm"><MoreHorizontal /></IconButton>}
          />
        </div>
      </div>
      {provider.failingSince && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive sm:ml-12">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">Fetches have failed since {formatClock(provider.failingSince)}</p>
            {provider.lastError && <p className="mt-0.5 break-words">Last error: {provider.lastError}</p>}
            <p className="mt-0.5 text-xs text-muted-foreground">Tracks it fails on stay playable. The first track it delivers clears this.</p>
          </div>
        </div>
      )}
      {unavailable > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2 text-sm sm:ml-12">
          <CircleSlash aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-[1_1_14rem] text-muted-foreground">
            {unavailable === 1 ? '1 track is' : `${unavailable} tracks are`} unavailable because it could not supply {unavailable === 1 ? 'it' : 'them'}. It is asked again within a day, or as soon as it reports a new version.
          </p>
          <Button size="sm" variant="outline" pending={retrying} onClick={() => void retry()}>{!retrying && <RotateCcw />}Retry unavailable tracks ({unavailable})</Button>
        </div>
      )}
      {result && (
        <div role="status" className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-sm sm:ml-12', result.ok ? 'bg-muted/40' : 'border-destructive/30 bg-destructive/10 text-destructive')}>
          {result.ok ? <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />}
          <span>{result.ok ? `Connected. It calls itself “${result.provider.capabilities?.name}”.` : `Could not connect: ${result.message}`}</span>
        </div>
      )}
      {capabilities && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-muted/50 px-3 py-2.5 sm:ml-12 sm:grid-cols-4">
          <Capability label="Reports itself as" value={capabilities.version ? `${capabilities.name} ${capabilities.version}` : capabilities.name} />
          <Capability label="Supplies" value={capabilities.kinds.map(kind => (kind === 'album' ? 'whole albums' : 'single songs')).join(', ')} />
          <Capability label="Formats" value={capabilities.formats.length ? capabilities.formats.join(', ') : 'Not said'} />
          <Capability label="At once" value={`${capabilities.maxConcurrent} ${capabilities.maxConcurrent === 1 ? 'request' : 'requests'}`} />
        </dl>
      )}
    </li>
  )
}

function Capability({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm tabular">{value}</dd>
    </div>
  )
}

const newProvider = { name: '', baseUrl: '', secret: '', priority: '0' }

/** Adds a provider, or edits one. The secret is write-only: editing leaves it alone unless a new one is typed. */
type ProviderFormProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Editing this provider; adding one without it. */
  provider?: AcquisitionProvider
  onAdd?: (request: z.input<typeof CreateAcquisitionProviderRequest>) => Promise<unknown>
  onSave?: (patch: UpdateAcquisitionProviderRequest) => Promise<unknown>
}

function ProviderFormDialog({ open, provider, onOpenChange, onAdd, onSave }: ProviderFormProps) {
  const initial = provider ? { name: provider.name, baseUrl: provider.baseUrl, secret: '', priority: String(provider.priority) } : newProvider
  const [value, setValue] = useState(initial)
  const adding = useFormSubmit(CreateAcquisitionProviderRequest, request => onAdd!(request))
  const editing = useFormSubmit(UpdateAcquisitionProviderRequest, patch => onSave!(patch))
  const form = provider ? editing : adding
  const close = (next: boolean) => {
    onOpenChange(next)
    if (!next) {
      setValue(initial)
      form.reset()
    }
  }
  const submit = async () => {
    const request = {
      name: value.name, baseUrl: value.baseUrl.trim(), priority: value.priority.trim() ? Number(value.priority) : 0,
      ...(provider && !value.secret ? {} : { secret: value.secret }),
    }
    if (await form.submit(request)) close(false)
  }
  const field = (key: keyof typeof newProvider) => ({
    id: `provider-${key}`,
    value: value[key],
    onChange: (event: { target: { value: string } }) => setValue({ ...value, [key]: event.target.value }),
    'aria-invalid': !!form.errors[key],
  })
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent title={provider ? `Edit ${provider.name}` : 'Add a provider'} description={provider ? undefined : 'The server asks it what it can do as soon as it is added.'}>
        <DialogForm onSubmit={() => void submit()} errors={form.errors} pending={form.pending} submitLabel={provider ? 'Save' : 'Add provider'}>
          <Field label="Name" htmlFor="provider-name" error={form.errors.name}>
            <Input {...field('name')} placeholder="Shelf" autoFocus />
          </Field>
          <Field label="Address" htmlFor="provider-baseUrl" error={form.errors.baseUrl} hint="The provider’s base URL, as this server reaches it.">
            <Input {...field('baseUrl')} inputMode="url" spellCheck={false} className="font-mono md:text-xs" placeholder="http://provider.lan:4801" />
          </Field>
          <Field label="Shared secret" htmlFor="provider-secret" error={form.errors.secret} hint={provider ? 'Saved and never shown. Type a new one to replace it.' : 'At least 8 characters. Sent with every request; never shown again.'}>
            <Input {...field('secret')} type="password" autoComplete="off" spellCheck={false} className="font-mono" placeholder={provider ? '••••••••' : undefined} />
          </Field>
          <Field label="Priority" htmlFor="provider-priority" error={form.errors.priority} hint="With several providers, higher ones are asked first.">
            <Input {...field('priority')} type="number" inputMode="numeric" className="w-28 tabular" />
          </Field>
        </DialogForm>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The cache (product decisions 16 to 20): every file a provider delivered, what of it is
 * pinned (saved, liked, in a playlist or a queue, or played in the last day) and so never
 * evicted, and the limit eviction works to.
 */
function CacheUsage({ usage, failure }: { usage: AcquisitionUsage | undefined; failure?: ReactNode }) {
  if (!usage) return failure ? <Panel title="Cache">{failure}</Panel> : <Skeleton className="h-32 rounded-xl" />
  const { cachedFiles, cachedBytes, pinnedBytes, limitBytes } = usage
  const evictable = Math.max(cachedBytes - pinnedBytes, 0)
  return (
    <Panel title="Cache" description="Songs fetched for playing are kept so they start at once next time. They are not part of anyone’s library and are not counted under Library.">
      {cachedFiles === 0 ? (
        <EmptyState icon={<HardDrive />} title="Nothing cached yet" description="Songs a provider delivers are counted here." className={cn(cardClass, 'py-8')} />
      ) : (
        <div className="@container flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4">
            <Stat label="Cached" value={formatBytes(cachedBytes)} detail={plural(cachedFiles, 'file')} />
            <Stat label="Kept" value={formatBytes(pinnedBytes)} detail="Saved, liked, in a playlist or queue, or played in the last day" />
            <Stat label="Can make room" value={formatBytes(evictable)} detail="Least recently played go first" />
            <Stat label="Limit" value={limitBytes ? formatBytes(limitBytes) : 'None'} detail={limitBytes ? `${Math.round((cachedBytes / limitBytes) * 100)}% used` : 'Nothing is ever deleted'} />
          </div>
          {limitBytes > 0 && (
            <div className={cn(cardClass, 'flex flex-col gap-2 p-4')}>
              <ProgressBar value={Math.min(cachedBytes / limitBytes, 1)} label="Cache used" />
              <p className="text-xs text-muted-foreground">
                {cachedBytes > limitBytes
                  ? pinnedBytes > limitBytes * 0.9
                    ? 'Over the limit with songs people hold on to. Raise the limit to keep room for new ones.'
                    : 'Over the limit. Songs nobody holds on to are deleted within the hour.'
                  : `${formatBytes(limitBytes - cachedBytes)} free`}
              </p>
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}

/** The target folder's "same as imports" choice; a select cannot hold null. */
const SAME_AS_IMPORTS = 'imports'
const MINUTE = 60

function PolicySettings({ policy, managedRoots, onSave, failure }: { policy: AcquisitionPolicy | undefined; managedRoots: LibraryRoot[] | undefined; onSave: SavePatch<UpdateAcquisitionPolicy>; failure?: ReactNode }) {
  if (!policy) return failure ? <Section title="Policy">{failure}</Section> : <Skeleton className="h-80 rounded-xl" />
  const roots = managedRoots ?? []
  const draft = { schema: UpdateAcquisitionPolicy, onSave }
  return (
    <Section
      title="Policy"
      description={<span className="block max-w-2xl">Admins, and members allowed to fetch missing music in Users, may start a fetch. Offers that come with a price are ignored in this version: a song only a priced offer could supply stays unavailable.</span>}
    >
      <Row label="Prefer lossless" description="When a provider offers several versions. Off picks the smaller lossy files.">
        <Switch aria-label="Prefer lossless" checked={policy.preferLossless} onCheckedChange={preferLossless => void onSave({ preferLossless }).catch(() => {})} />
      </Row>
      <Row htmlFor="policy-file" label="Largest file" description="A delivery with a bigger file fails.">
        <DraftField id="policy-file" field="maxFileBytes" value={policy.maxFileBytes} {...draft} type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="MB" {...inMegabytes} />
      </Row>
      <Row htmlFor="policy-quota" label="Cache limit" description="Once fetched music takes more, the least recently played songs nobody holds on to are deleted until it is under 90% of this. Playing is never refused. 0 means no limit.">
        <DraftField id="policy-quota" field="storageQuotaBytes" value={policy.storageQuotaBytes} {...draft} type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="GB" {...inGigabytes} />
      </Row>
      <Row htmlFor="policy-timeout" label="Give up after" description="A provider that has not delivered by then fails the request.">
        <DraftField
          id="policy-timeout" field="timeoutSeconds" value={policy.timeoutSeconds} {...draft} type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="min"
          format={seconds => String(Math.round((Number(seconds) / MINUTE) * 10) / 10)} parse={text => (text.trim() ? Math.round(Number(text) * MINUTE) : Number.NaN)}
        />
      </Row>
      <Row label="Keep in" description={<>The managed folder whose <span className="font-mono">_Fetched</span> folder holds the cache. Imports use the one in <Link to="/admin/settings" className="text-primary underline-offset-4 hover:underline">Server settings</Link>.</>}>
        <Select
          label="Keep in"
          className="w-64 max-w-full"
          value={policy.targetRootId ?? SAME_AS_IMPORTS}
          options={[
            { value: SAME_AS_IMPORTS, label: 'Same as imports' },
            ...roots.map(root => ({ value: root.id, label: root.name })),
            ...(policy.targetRootId && managedRoots && !roots.some(root => root.id === policy.targetRootId) ? [{ value: policy.targetRootId, label: 'A folder that is no longer managed' }] : []),
          ]}
          onValueChange={value => void onSave({ targetRootId: value === SAME_AS_IMPORTS ? null : value }).catch(() => {})}
        />
      </Row>
      <Row
        htmlFor="policy-delivery"
        label="Delivery address"
        description="Providers send files back to this server here. Leave it empty to use PUBLIC_URL, or this server’s local address; set it when a provider reaches the server another way, such as from another container (http://squirmy:4747)."
      >
        <DraftField id="policy-delivery" field="deliveryBaseUrl" value={policy.deliveryBaseUrl} {...draft} inputMode="url" placeholder="Automatic" className="w-64 font-mono md:text-xs" parse={text => text.trim() || null} />
      </Row>
    </Section>
  )
}

const jobStatusLabels: Record<AcquisitionJobStatus, string> = {
  resolving: 'Finding it', queued: 'Queued', downloading: 'Arriving', importing: 'Importing', completed: 'Done', failed: 'Failed', rejected: 'Refused',
}
const runningStatuses = new Set<AcquisitionJobStatus>(['resolving', 'queued', 'downloading', 'importing'])
const ALL = 'all'

function JobsList({ jobs, more, status, onStatusChange, failure }: { jobs: AcquisitionJob[] | undefined; more?: MoreJobs; status: AcquisitionJobStatus | null; onStatusChange: (status: AcquisitionJobStatus | null) => void; failure?: ReactNode }) {
  return (
    <Panel
      title="Requests"
      description="Every fetch: who asked, what for, which provider, and how it ended."
      action={(
        <Select
          label="Show requests"
          prefix="Show"
          size="sm"
          value={status ?? ALL}
          options={[{ value: ALL, label: 'All' }, ...AcquisitionJobStatus.options.map(value => ({ value, label: jobStatusLabels[value] }))]}
          onValueChange={value => onStatusChange(value === ALL ? null : value as AcquisitionJobStatus)}
        />
      )}
    >
      {!jobs && (failure ?? <Skeleton className="h-24 rounded-xl" />)}
      {jobs?.length === 0 && <EmptyState icon={<History />} title={status ? `Nothing ${jobStatusLabels[status].toLowerCase()}` : 'No requests yet'} description="Requests appear here as soon as someone plays or asks for music the server does not have." className={cn(cardClass, 'py-10')} />}
      {jobs && jobs.length > 0 && (
        <ul aria-label="Requests" className={cn(cardClass, 'divide-y')}>
          {jobs.map(job => (
            <li key={job.id} className="flex items-start gap-4 px-4 py-2.5 transition-colors hover:bg-muted/30">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {job.albumId && !job.trackId ? <Link to={`/album/${job.albumId}`} className="underline-offset-4 hover:underline">{job.title}</Link> : job.title}
                </p>
                <p className="text-xs text-muted-foreground sm:truncate">
                  {[job.trackId ? 'Song' : 'Album', job.providerName, job.requestedBy ? `@${job.requestedBy}` : 'a deleted user', `asked ${formatRelative(job.createdAt)}`, job.completedAt ? `ended ${formatRelative(job.completedAt)}` : `updated ${formatRelative(job.updatedAt)}`].filter(Boolean).join(' · ')}
                </p>
                {job.error && <p className="mt-0.5 text-xs text-destructive">{job.error}</p>}
              </div>
              <Badge tone={job.status === 'failed' || job.status === 'rejected' ? 'danger' : job.status === 'completed' ? 'accent' : 'neutral'} className="mt-0.5">
                {runningStatuses.has(job.status) && <Spinner label="" className="size-3 text-current" />}
                {jobStatusLabels[job.status]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {jobs && jobs.length > 0 && more && (
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
          {more.failed && !more.loading && <p role="alert" className="text-sm text-destructive">The older requests did not load.</p>}
          <Button variant="outline" size="sm" onClick={more.load} pending={more.loading}>{more.failed && !more.loading ? 'Try again' : 'Show older requests'}</Button>
        </div>
      )}
    </Panel>
  )
}
