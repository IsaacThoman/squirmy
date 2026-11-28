import { queryKeys, type DuplicateGroup, type HealthStatus, type HygieneFile } from '@squirmy/contracts'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { errorMessage } from '@/api/errors'
import { useApi } from '@/api/services'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog, DialogContent } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/feedback'
import { Input } from '@/components/ui/input'
import { loadFailure } from '@/components/ui/load-failure'
import { Select } from '@/components/ui/select'
import { formatRelative } from '@/lib/format'
import { AdminHeader } from './AdminLayout'
import { DataTable, FolderPath, InlineNote, Panel, Td, Th, Tr } from './Panel'

const hygieneKey = [...queryKeys.admin(), 'hygiene'] as const
const duplicateViews = [
  { value: 'recordings', label: 'Recordings' },
  { value: 'albums', label: 'Albums' },
  { value: 'quality', label: 'Low quality' },
] as const
const healthViews = [
  { value: 'all', label: 'All files' },
  { value: 'issues', label: 'Issues' },
] as const
const groupReason = {
  recording: 'Same MusicBrainz recording',
  audio: 'Identical audio stream',
  tags: 'Same artist and title, within two seconds',
  album: 'Same album and artist in multiple library groups',
} satisfies Record<DuplicateGroup['reason'], string>

function Format({ file }: { file: HygieneFile }) {
  const codec = file.container.toLowerCase() === file.codec.toLowerCase() ? file.codec : `${file.container} · ${file.codec}`
  const details = [
    file.lossless ? 'Lossless' : null,
    file.bitrate ? `${Math.round(file.bitrate / 1000)} kbps` : null,
    file.bitDepth ? `${file.bitDepth}-bit` : null,
    file.sampleRate ? `${file.sampleRate / 1000} kHz` : null,
  ].filter(Boolean)
  return <div className="min-w-30"><div>{codec}</div><div className="text-xs text-muted-foreground">{details.join(' · ')}</div></div>
}

function FileLabel({ file }: { file: HygieneFile }) {
  return <div className="min-w-44">
    <div className="font-medium">{file.title}</div>
    <div className="text-xs text-muted-foreground">
      {file.artist}{file.artist && file.album && ' · '}{file.albumId && file.album
        ? <Link className="hover:underline" to={`/album/${file.albumId}`}>{file.album}</Link>
        : file.album}
    </div>
  </div>
}

type DuplicateChoice = { file: HygieneFile; keepId: string; reason: Exclude<DuplicateGroup['reason'], 'album'> }

function DuplicateTable({ group, onDelete }: { group: DuplicateGroup; onDelete: (choice: DuplicateChoice) => void }) {
  const [kept, setKept] = useState<string | null>(null)
  const keepId = group.files.some(file => file.id === kept) ? kept : group.bestId
  const reason = group.reason
  return (
    <Panel title={group.label} description={groupReason[group.reason]}
      action={group.bestId && keepId && <Select label="Copy to keep" value={keepId} onValueChange={setKept} size="sm" prefix="Keep"
        className="max-w-56 sm:max-w-80" options={group.files.map(file => ({
          value: file.id, label: file.path,
        }))} />}>
      <DataTable>
        <thead><tr><Th>Track</Th><Th>Format</Th><Th>File path</Th><Th>Action</Th></tr></thead>
        <tbody>{group.files.map(file => (
          <Tr key={file.id}>
            <Td><FileLabel file={file} />{file.id === group.bestId && <Badge className="mt-1">Suggested copy</Badge>}</Td>
            <Td><Format file={file} /></Td>
            <Td><FolderPath path={file.path} className="min-w-48 max-w-md" /></Td>
            <Td className="whitespace-nowrap">
              {keepId && (file.id === keepId ? <span className="text-xs text-muted-foreground">Keep</span>
                : !file.managed ? <span className="text-xs text-muted-foreground">Deletion unavailable</span>
                  : reason !== 'album' && <Button size="sm" variant="outline" onClick={() => onDelete({ file, keepId, reason })}>Delete copy…</Button>)}
            </Td>
          </Tr>
        ))}</tbody>
      </DataTable>
    </Panel>
  )
}

function LoadMore({ hasNextPage, fetching, load }: { hasNextPage: boolean; fetching: boolean; load: () => unknown }) {
  return hasNextPage && <div><Button variant="outline" pending={fetching} onClick={() => void load()}>Load more</Button></div>
}

export function DuplicatesAdmin() {
  const api = useApi()
  const cache = useQueryClient()
  const [view, setView] = useState<'recordings' | 'albums' | 'quality'>('recordings')
  const [choice, setChoice] = useState<DuplicateChoice | null>(null)
  const results = useInfiniteQuery({
    queryKey: [...hygieneKey, 'duplicates', view],
    queryFn: ({ pageParam }) => api.admin.duplicates({ kind: view === 'albums' ? 'albums' : 'recordings', cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined, enabled: view !== 'quality',
  })
  const groups = results.data?.pages.flatMap(page => page.items)
  const remove = useMutation({
    mutationFn: ({ file, keepId, reason }: DuplicateChoice) => api.admin.removeDuplicate(file.id, { keepId, reason, revision: file.revision }),
    onSuccess: () => cache.invalidateQueries({ queryKey: hygieneKey }),
  })
  return (
    <>
      <AdminHeader title="Duplicates & quality" description="Compare copies on your server and find lossy files below 192 kbps.">
        <Select label="Library view" value={view} options={duplicateViews} onValueChange={setView} />
      </AdminHeader>
      {view === 'quality' ? <LowQualityTable /> : (
        <div className="flex flex-col gap-6">
          {loadFailure(results, 'The duplicates did not load')}
          {!results.data && results.isPending && <Status>Looking for duplicates…</Status>}
          {groups?.length === 0 && <Status>No likely duplicate {view} found.</Status>}
          {groups?.map(group => <DuplicateTable key={group.id} group={group} onDelete={setChoice} />)}
          <LoadMore hasNextPage={results.hasNextPage} fetching={results.isFetchingNextPage} load={results.fetchNextPage} />
        </div>
      )}
      {choice && (
        <ConfirmDialog open onOpenChange={open => { if (!open) setChoice(null) }}
          title="Permanently delete this copy?" confirmLabel="Delete copy" onConfirm={() => remove.mutateAsync(choice)}
          description={<>This removes the file from the server for everyone. <span className="mt-2 block break-all font-mono text-xs">{choice.file.path}</span></>} />
      )}
    </>
  )
}

function Status({ children }: { children: ReactNode }) {
  return <p role="status" className="text-sm text-muted-foreground">{children}</p>
}

function LowQualityTable() {
  const api = useApi()
  const result = useInfiniteQuery({
    queryKey: [...hygieneKey, 'quality'],
    queryFn: ({ pageParam }) => api.admin.lowQuality({ cursor: pageParam }),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const files = result.data?.pages.flatMap(page => page.items)
  return loadFailure(result, 'File quality did not load') ?? (
    <div className="flex flex-col gap-3">
      {!files ? <Status>Looking for low-bitrate files…</Status> : files.length === 0 ? <Status>No lossy files below 192 kbps found.</Status> : (
        <DataTable>
          <thead><tr><Th>Track</Th><Th>Format</Th><Th>File path</Th></tr></thead>
          <tbody>{files.map(file => <Tr key={file.id}><Td><FileLabel file={file} /></Td><Td><Format file={file} /></Td>
            <Td><FolderPath path={file.path} className="min-w-48 max-w-xl" /></Td></Tr>)}</tbody>
        </DataTable>
      )}
      <LoadMore hasNextPage={result.hasNextPage} fetching={result.isFetchingNextPage} load={result.fetchNextPage} />
    </div>
  )
}

const healthLabels: Record<HealthStatus, string> = {
  healthy: 'Healthy', decode_error: 'Decode failed', hash_changed: 'Audio hash changed',
  no_hash: 'No scan hash', unavailable: 'Could not check',
}

export function FileHealthAdmin() {
  const api = useApi()
  const cache = useQueryClient()
  const [view, setView] = useState<'all' | 'issues'>('all')
  const [folder, setFolder] = useState<HygieneFile | null>(null)
  const result = useInfiniteQuery({
    queryKey: [...hygieneKey, 'health', view],
    queryFn: ({ pageParam }) => api.admin.fileHealth({ cursor: pageParam, issues: view === 'issues' }),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(file => file.pending)) ? 2500 : 30_000,
  })
  const recheck = useMutation({
    mutationFn: api.admin.recheckFile,
    onSuccess: () => cache.invalidateQueries({ queryKey: [...hygieneKey, 'health'] }),
  })
  const files = result.data?.pages.flatMap(page => page.items)
  return (
    <>
      <AdminHeader title="File health" description="Background checks decode audio and compare it with the library’s stored hash.">
        <Select label="File health view" value={view} options={healthViews} onValueChange={setView} />
      </AdminHeader>
      {loadFailure(result, 'File health did not load') ?? (
        <div className="flex flex-col gap-3">
          {!files ? <Status>Loading files…</Status> : !files.length ? <Status>{view === 'issues' ? 'No file health issues reported.' : 'No collection files found.'}</Status> : (
            <DataTable>
              <thead><tr><Th>Track</Th><Th>Result</Th><Th>Server folder</Th><Th>Action</Th></tr></thead>
              <tbody>{files.map(file => (
                <Tr key={file.id}>
                  <Td><FileLabel file={file} /></Td>
                  <Td className="min-w-44">
                    <div className="font-medium">{file.pending ? 'Check queued' : file.status ? healthLabels[file.status] : 'Unchecked'}</div>
                    {file.checkedAt && <div className="text-xs text-muted-foreground">{formatRelative(file.checkedAt)}</div>}
                    {file.detail && <p className="mt-1 max-w-80 break-words text-xs text-muted-foreground">{file.detail}</p>}
                  </Td>
                  <Td><FolderPath path={file.folder} className="min-w-44 max-w-sm" />
                    <Button size="sm" variant="ghost" onClick={() => setFolder(file)}>Show folder path</Button></Td>
                  <Td className="whitespace-nowrap">
                    <Button size="sm" variant="outline" disabled={file.pending || recheck.isPending}
                      onClick={() => recheck.mutate(file.id)}>{file.checkedAt ? 'Re-check' : 'Check file'}</Button>
                    {recheck.variables === file.id && <InlineNote note={recheck.error ? { tone: 'error', text: errorMessage(recheck.error) } : null} />}
                  </Td>
                </Tr>
              ))}</tbody>
            </DataTable>
          )}
          <LoadMore hasNextPage={result.hasNextPage} fetching={result.isFetchingNextPage} load={result.fetchNextPage} />
        </div>
      )}
      {folder && <ServerFolder path={folder.folder} onClose={() => setFolder(null)} />}
    </>
  )
}

function ServerFolder({ path, onClose }: { path: string; onClose: () => void }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent title="Server folder" description="Use this path in the file manager on the server or its mounted storage.">
      <Input aria-label="Server folder path" value={path} readOnly onFocus={event => event.currentTarget.select()} />
    </DialogContent>
  </Dialog>
}
