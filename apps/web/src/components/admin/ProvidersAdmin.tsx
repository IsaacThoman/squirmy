import {
  AcquisitionJobStatus, CreateAcquisitionProviderRequest, UpdateAcquisitionPolicy, UpdateAcquisitionProviderRequest,
  type AcquisitionJob, type AcquisitionPolicy, type AcquisitionProvider, type LibraryRoot,
} from '@squirmy/contracts'
import { CircleAlert, CircleCheck, History, MoreHorizontal, PlugZap, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import type { z } from 'zod'
import { useFormSubmit } from '@/api/errors'
import { SettingRow, SettingsSection } from '@/components/layout/Settings'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog, DialogContent } from '@/components/ui/dialog'
import { Badge, EmptyState, Skeleton, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { Field, Input } from '@/components/ui/input'
import { DropdownMenu } from '@/components/ui/menu'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { formatRelative, inGigabytes, inMegabytes } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminHeader, DialogForm } from './AdminLayout'
import { DraftField, type SavePatch } from './DraftField'

type ProvidersAdminProps = {
  /** Undefined while loading. */
  providers: AcquisitionProvider[] | undefined
  policy: AcquisitionPolicy | undefined
  /** Managed library folders fetched music can be filed into. */
  managedRoots: LibraryRoot[] | undefined
  jobs: AcquisitionJob[] | undefined
  jobStatus: AcquisitionJobStatus | null
  onJobStatusChange: (status: AcquisitionJobStatus | null) => void
  onCreate: (request: z.input<typeof CreateAcquisitionProviderRequest>) => Promise<unknown>
  onUpdate: (providerId: string, patch: UpdateAcquisitionProviderRequest) => Promise<unknown>
  onDelete: (providerId: string) => Promise<unknown>
  /** Asks the provider for its capabilities; resolves to the provider as it answered. */
  onTest: (providerId: string) => Promise<AcquisitionProvider>
  onSavePolicy: SavePatch<UpdateAcquisitionPolicy>
}

type ProviderDialog = { kind: 'add' } | { kind: 'edit' | 'delete'; provider: AcquisitionProvider }

const coverageLabels = { assume_available: 'Offers everything', must_resolve: 'Checks each track' } as const

/** Acquisition providers: the services that can supply missing music, how they are used, and what they were asked for. */
export function ProvidersAdmin({ providers, policy, managedRoots, jobs, jobStatus, onJobStatusChange, onCreate, onUpdate, onDelete, onTest, onSavePolicy }: ProvidersAdminProps) {
  const [dialog, setDialog] = useState<ProviderDialog | null>(null)
  const close = (open: boolean) => { if (!open) setDialog(null) }
  return (
    <div className="flex flex-col gap-9">
      <AdminHeader
        title="Providers"
        description="A provider is a separate service you run that can supply music this server does not have. With one connected, missing songs play on demand and are filed into the library like any other import; until you add one, nothing is ever fetched."
      >
        <Button variant="primary" onClick={() => setDialog({ kind: 'add' })}><Plus />Add provider</Button>
      </AdminHeader>

      <section aria-label="Providers" className="-mt-6">
        {!providers && <Skeleton className="h-32 rounded-2xl" />}
        {providers?.length === 0 && (
          <div className="rounded-2xl bg-sheet ring-1 ring-stroke">
            <EmptyState
              icon={<PlugZap />}
              title="No providers"
              description="On-demand fetching is off. Add a provider by its address and the shared secret you gave it."
              action={<Button variant="primary" onClick={() => setDialog({ kind: 'add' })}><Plus />Add provider</Button>}
            />
          </div>
        )}
        <ul className="flex flex-col gap-3">
          {providers?.map(provider => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              onToggle={enabled => void onUpdate(provider.id, { enabled }).catch(() => {})}
              onTest={() => onTest(provider.id)}
              onEdit={() => setDialog({ kind: 'edit', provider })}
              onDelete={() => setDialog({ kind: 'delete', provider })}
            />
          ))}
        </ul>
      </section>

      <PolicySettings policy={policy} managedRoots={managedRoots} onSave={onSavePolicy} />
      <JobsList jobs={jobs} status={jobStatus} onStatusChange={onJobStatusChange} />

      <ProviderFormDialog open={dialog?.kind === 'add'} onOpenChange={close} onAdd={onCreate} />
      {dialog?.kind === 'edit' && <ProviderFormDialog open provider={dialog.provider} onOpenChange={close} onSave={patch => onUpdate(dialog.provider.id, patch)} />}
      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onOpenChange={close}
        title={dialog?.kind === 'delete' ? `Delete ${dialog.provider.name}?` : ''}
        description="The server stops asking it for music. Music it already supplied stays in the library."
        confirmLabel="Delete provider"
        onConfirm={() => dialog?.kind === 'delete' ? onDelete(dialog.provider.id) : Promise.resolve()}
      />
    </div>
  )
}

type TestResult = { ok: true; provider: AcquisitionProvider } | { ok: false; message: string }

function ProviderCard({ provider, onToggle, onTest, onEdit, onDelete }: { provider: AcquisitionProvider; onToggle: (enabled: boolean) => void; onTest: () => Promise<AcquisitionProvider>; onEdit: () => void; onDelete: () => void }) {
  const [testing, setTesting] = useState(false)
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
  const working = provider.enabled && capabilities && !provider.lastError
  return (
    <li aria-label={provider.name} className="rounded-2xl bg-sheet p-4 ring-1 ring-stroke">
      <div className="flex items-start gap-4">
        <div className={cn('flex size-11 shrink-0 items-center justify-center rounded-xl', working ? 'bg-selection text-accent' : 'bg-surface text-quiet')}><PlugZap className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-bold">{provider.name}</h3>
            {provider.enabled ? <Badge tone="accent">Enabled</Badge> : <Badge>Disabled</Badge>}
            <Badge tone="outline">{coverageLabels[provider.coverage]}</Badge>
            {provider.priority !== 0 && <Badge tone="outline">Priority {provider.priority}</Badge>}
          </div>
          <p className="mt-0.5 truncate font-mono text-[13px] text-muted" title={provider.baseUrl}>{provider.baseUrl}</p>
          <p className={cn('mt-1.5 text-xs', provider.lastError ? 'font-medium text-danger' : 'text-quiet')}>
            {provider.lastError
              ? `Last error: ${provider.lastError}`
              : provider.lastOkAt ? `Answered ${formatRelative(provider.lastOkAt)}` : 'Has not answered yet'}
            {provider.lastError && provider.lastOkAt && <span className="font-normal text-quiet"> · last answered {formatRelative(provider.lastOkAt)}</span>}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Switch aria-label={`Enable ${provider.name}`} checked={provider.enabled} onCheckedChange={onToggle} className="mr-2" />
          <Button size="sm" className="max-sm:hidden" pending={testing} onClick={() => void test()}>{!testing && <RefreshCw />}Test connection</Button>
          <DropdownMenu
            entries={[
              { label: 'Test connection', onSelect: () => void test() },
              { label: 'Edit…', onSelect: onEdit },
              { kind: 'separator' },
              { label: 'Delete provider…', danger: true, onSelect: onDelete },
            ]}
            trigger={<IconButton label={`More options for ${provider.name}`} size="sm"><MoreHorizontal /></IconButton>}
          />
        </div>
      </div>
      {result && (
        <div role="status" className={cn('mt-4 flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px]', result.ok ? 'bg-selection text-foreground' : 'bg-danger/10 text-danger')}>
          {result.ok ? <CircleCheck aria-hidden className="mt-px size-4 shrink-0 text-accent" /> : <CircleAlert aria-hidden className="mt-px size-4 shrink-0" />}
          <span className="font-medium">{result.ok ? `Connected. It calls itself “${result.provider.capabilities?.name}”.` : `Could not connect: ${result.message}`}</span>
        </div>
      )}
      {capabilities && (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 rounded-xl bg-surface px-3.5 py-3 text-[13px] sm:grid-cols-4">
          <Capability label="Reports itself as" value={capabilities.name} />
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
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate font-semibold">{value}</dd>
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
            <Input {...field('baseUrl')} inputMode="url" spellCheck={false} className="font-mono text-[14px]" placeholder="http://provider.lan:4801" />
          </Field>
          <Field label="Shared secret" htmlFor="provider-secret" error={form.errors.secret} hint={provider ? 'Saved and never shown. Type a new one to replace it.' : 'At least 8 characters. Sent with every request; never shown again.'}>
            <Input {...field('secret')} type="password" autoComplete="off" spellCheck={false} className="font-mono" placeholder={provider ? '••••••••' : undefined} />
          </Field>
          <Field label="Priority" htmlFor="provider-priority" error={form.errors.priority} hint="With several providers, higher ones are asked first.">
            <Input {...field('priority')} type="number" inputMode="numeric" className="w-28" />
          </Field>
        </DialogForm>
      </DialogContent>
    </Dialog>
  )
}

/** The target folder's "same as imports" choice; a select cannot hold null. */
const SAME_AS_IMPORTS = 'imports'
const MINUTE = 60

function PolicySettings({ policy, managedRoots, onSave }: { policy: AcquisitionPolicy | undefined; managedRoots: LibraryRoot[] | undefined; onSave: SavePatch<UpdateAcquisitionPolicy> }) {
  if (!policy) return <Skeleton className="h-80 rounded-2xl" />
  const roots = managedRoots ?? []
  const draft = { schema: UpdateAcquisitionPolicy, onSave }
  return (
    <SettingsSection
      title="Policy"
      description="Admins, and members allowed to fetch missing music in Users, may start a fetch. Offers that come with a price are ignored in this version: a song only a priced offer could supply stays unavailable."
    >
      <SettingRow label="Prefer lossless" description="When a provider offers several versions. Off picks the smaller lossy files.">
        <Switch aria-label="Prefer lossless" checked={policy.preferLossless} onCheckedChange={preferLossless => void onSave({ preferLossless }).catch(() => {})} />
      </SettingRow>
      <SettingRow htmlFor="policy-file" label="Largest file" description="A delivery with a bigger file fails.">
        <DraftField id="policy-file" field="maxFileBytes" value={policy.maxFileBytes} {...draft} type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="MB" {...inMegabytes} />
      </SettingRow>
      <SettingRow htmlFor="policy-quota" label="Storage for fetched music" description="Fetching stops once fetched files take this much. 0 means no limit.">
        <DraftField id="policy-quota" field="storageQuotaBytes" value={policy.storageQuotaBytes} {...draft} type="number" inputMode="decimal" step="any" className="w-24 text-right" unit="GB" {...inGigabytes} />
      </SettingRow>
      <SettingRow htmlFor="policy-timeout" label="Give up after" description="A provider that has not delivered by then fails the request.">
        <DraftField
          id="policy-timeout" field="timeoutSeconds" value={policy.timeoutSeconds} {...draft} type="number" inputMode="decimal" step="any" className="w-20 text-right" unit="min"
          format={seconds => String(Math.round((Number(seconds) / MINUTE) * 10) / 10)} parse={text => (text.trim() ? Math.round(Number(text) * MINUTE) : Number.NaN)}
        />
      </SettingRow>
      <SettingRow label="File into" description={<>Which managed folder fetched music goes to. Imports use the one in <Link to="/admin/settings" className="font-semibold text-accent hover:underline">Server settings</Link>.</>}>
        <Select
          label="File into"
          value={policy.targetRootId ?? SAME_AS_IMPORTS}
          options={[
            { value: SAME_AS_IMPORTS, label: 'Same as imports' },
            ...roots.map(root => ({ value: root.id, label: root.name })),
            ...(policy.targetRootId && managedRoots && !roots.some(root => root.id === policy.targetRootId) ? [{ value: policy.targetRootId, label: 'A folder that is no longer managed' }] : []),
          ]}
          onValueChange={value => void onSave({ targetRootId: value === SAME_AS_IMPORTS ? null : value }).catch(() => {})}
        />
      </SettingRow>
      <SettingRow
        htmlFor="policy-delivery"
        label="Delivery address"
        description="Providers send files back to this server here. Leave it empty to use PUBLIC_URL, or this server’s local address; set it when a provider reaches the server another way, such as from another container (http://squirmy:4747)."
      >
        <DraftField id="policy-delivery" field="deliveryBaseUrl" value={policy.deliveryBaseUrl} {...draft} inputMode="url" placeholder="Automatic" className="w-64 font-mono text-[13px]" parse={text => text.trim() || null} />
      </SettingRow>
    </SettingsSection>
  )
}

const jobStatusLabels: Record<AcquisitionJobStatus, string> = {
  resolving: 'Finding it', queued: 'Queued', downloading: 'Arriving', importing: 'Importing', completed: 'Done', failed: 'Failed', rejected: 'Refused',
}
const runningStatuses = new Set<AcquisitionJobStatus>(['resolving', 'queued', 'downloading', 'importing'])
const ALL = 'all'

function JobsList({ jobs, status, onStatusChange }: { jobs: AcquisitionJob[] | undefined; status: AcquisitionJobStatus | null; onStatusChange: (status: AcquisitionJobStatus | null) => void }) {
  return (
    <SettingsSection
      title="Requests"
      description="Every fetch: who asked, what for, which provider, and how it ended."
      action={(
        <Select
          label="Show requests"
          prefix="Show"
          value={status ?? ALL}
          options={[{ value: ALL, label: 'All' }, ...AcquisitionJobStatus.options.map(value => ({ value, label: jobStatusLabels[value] }))]}
          onValueChange={value => onStatusChange(value === ALL ? null : value as AcquisitionJobStatus)}
        />
      )}
    >
      {!jobs && <div className="p-4"><Skeleton className="h-16" /></div>}
      {jobs?.length === 0 && <EmptyState icon={<History />} title={status ? `Nothing ${jobStatusLabels[status].toLowerCase()}` : 'No requests yet'} description="Requests appear here as soon as someone plays or asks for music the server does not have." className="py-10" />}
      {jobs && jobs.length > 0 && (
        <ul aria-label="Requests" className="divide-y divide-stroke">
          {jobs.map(job => (
            <li key={job.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">
                  {job.albumId && !job.trackId ? <Link to={`/album/${job.albumId}`} className="hover:underline">{job.title}</Link> : job.title}
                </p>
                <p className="truncate text-[13px] text-muted">
                  {[job.trackId ? 'Song' : 'Album', job.providerName, job.requestedBy ? `@${job.requestedBy}` : 'a deleted user', `asked ${formatRelative(job.createdAt)}`, job.completedAt ? `ended ${formatRelative(job.completedAt)}` : `updated ${formatRelative(job.updatedAt)}`].filter(Boolean).join(' · ')}
                </p>
                {job.error && <p className="mt-0.5 text-[13px] font-medium text-danger">{job.error}</p>}
              </div>
              <Badge tone={job.status === 'failed' || job.status === 'rejected' ? 'danger' : job.status === 'completed' ? 'accent' : 'neutral'} className="self-start sm:self-center">
                {runningStatuses.has(job.status) && <Spinner label="" className="size-3 text-current" />}
                {jobStatusLabels[job.status]}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </SettingsSection>
  )
}
