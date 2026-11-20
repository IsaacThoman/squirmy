/**
 * Adding music: uploads, and the imports list and detail. A separate download, like the
 * admin pages; most visits never open them.
 */
import { ApiError } from '@squirmy/client-core'
import { queryKeys, type Import } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Upload as UploadIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link, useParams } from 'react-router'
import { importsKey, isNotFound } from '@/api/queries'
import { useApi } from '@/api/services'
import { useCurrentUser } from '@/auth/session'
import { ImportDetail } from '@/components/imports/ImportDetail'
import { ImportsList } from '@/components/imports/ImportsList'
import { NotTaken, UploadPanel } from '@/components/imports/UploadPanel'
import { Page } from '@/components/layout/Page'
import { PageTitle, SectionHeader } from '@/components/music/SectionHeader'
import { Button } from '@/components/ui/button'
import { EmptyState, Skeleton } from '@/components/ui/feedback'
import { canUploadMusic } from '@/lib/catalog'
import { toast } from '@/lib/toast'
import { byPath, droppedFiles, pickedFiles, Upload, type PickedFile } from '@/lib/upload'
import { useServerEvent } from '@/realtime/realtime-context'
import { NotFoundPage } from './music'

const optionsKey = [...importsKey, 'options'] as const
const listKey = [...importsKey, 'list'] as const
const importKey = (id: string) => [...importsKey, 'detail', id] as const
const albumsKey = (id: string) => [...importsKey, 'albums', id] as const

/** This tab's upload. It outlives the page, so leaving it and coming back finds the upload going on. */
let active: Upload | null = null
const activeListeners = new Set<() => void>()
const subscribeActive = (listener: () => void) => {
  activeListeners.add(listener)
  return () => activeListeners.delete(listener)
}
function setActive(upload: Upload | null) {
  active = upload
  for (const listener of [...activeListeners]) listener()
}
const idle = () => () => {}
const nothing = () => null

function useActiveUpload() {
  const upload = useSyncExternalStore(subscribeActive, () => active)
  const snapshot = useSyncExternalStore(upload?.subscribe ?? idle, upload?.getSnapshot ?? nothing)
  return { upload, snapshot }
}

/** Imports announce every step; whatever shows them refreshes. */
function useImportEvents() {
  const queryClient = useQueryClient()
  useServerEvent('import.updated', () => void queryClient.invalidateQueries({ queryKey: importsKey }))
}

/** Who started an import: names for admins, who see everyone's; members see only their own. */
function useOwners() {
  const api = useApi()
  const me = useCurrentUser()
  const isAdmin = me.role === 'admin'
  const users = useQuery({ queryKey: queryKeys.adminUsers(), queryFn: () => api.admin.users(), enabled: isAdmin, meta: { silent: true } })
  const names = new Map(users.data?.items.map(user => [user.id, user.id === me.id ? 'you' : `@${user.username}`]))
  return (item: Import) => (isAdmin && item.userId ? names.get(item.userId) ?? null : null)
}

/** A live import, starting from what is already known of it. */
function useImport(id: string | undefined, initial?: Import | null) {
  const api = useApi()
  const item = useQuery({ queryKey: importKey(id ?? ''), queryFn: () => api.imports.getImport(id!), enabled: !!id, initialData: initial ?? undefined, meta: { silent: true } })
  const albums = useQuery({
    queryKey: albumsKey(id ?? ''),
    queryFn: () => api.imports.importAlbums(id!),
    enabled: item.data?.status === 'completed',
    select: page => page.items,
    meta: { silent: true },
  })
  return { item, albums: albums.data }
}

function useCancelImport() {
  const api = useApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (item: Import) => api.imports.cancelImport(item.id),
    onSuccess: () => {
      toast({ title: 'Import cancelled', description: 'The files it received are gone.' })
      return queryClient.invalidateQueries({ queryKey: importsKey })
    },
  })
}

export function ImportsPage() {
  const user = useCurrentUser()
  if (!canUploadMusic(user)) {
    return (
      <Page>
        <EmptyState icon={<UploadIcon />} title="Uploading is not on for your account" description="Ask an admin of this server to let you upload music." className="pt-24" />
      </Page>
    )
  }
  return <AddMusic />
}

function AddMusic() {
  const api = useApi()
  const user = useCurrentUser()
  const isAdmin = user.role === 'admin'
  useImportEvents()
  const options = useQuery({ queryKey: optionsKey, queryFn: () => api.imports.importOptions() })
  const recent = useQuery({ queryKey: listKey, queryFn: () => api.imports.listImports({ limit: 30 }), select: page => page.items })
  const ownerOf = useOwners()
  const cancelImport = useCancelImport()
  const { upload, snapshot } = useActiveUpload()
  const [reading, setReading] = useState(false)
  const committed = snapshot?.phase === 'committed' ? snapshot.import : null
  const live = useImport(committed?.id, committed)

  // Closing the tab mid-upload loses what is not sent yet; the browser asks first.
  const sending = snapshot?.phase === 'sending'
  useEffect(() => {
    if (!sending) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [sending])

  const choose = (picked: PickedFile[]) => {
    if (!options.data) return
    if (!picked.length) return toast({ title: 'Nothing to upload', description: 'No files were found in what you chose.' })
    // Files added before the upload starts join it; the same path is not added twice.
    const before = snapshot?.phase === 'ready' ? upload!.picked : []
    const paths = new Set(before.map(file => file.path))
    setActive(new Upload(api.imports, byPath([...before, ...picked.filter(file => !paths.has(file.path))]), options.data))
  }

  return (
    <Page className="flex max-w-4xl flex-col gap-9">
      <div>
        <PageTitle>Add music</PageTitle>
        <p className="mt-1 max-w-xl text-[15px] text-muted">Upload albums from this computer. The server identifies them and files them into the library, and anything it cannot place waits for review.</p>
      </div>

      {committed && live.item.data ? (
        <section aria-label="Upload" className="flex flex-col gap-4">
          <ImportDetail item={live.item.data} albums={live.albums} isAdmin={isAdmin}>
            {snapshot && <NotTaken files={snapshot.files} />}
          </ImportDetail>
          <div><Button variant="primary" onClick={() => setActive(null)}><UploadIcon />Upload more</Button></div>
        </section>
      ) : (
        <UploadPanel
          options={options.data}
          isAdmin={isAdmin}
          upload={snapshot}
          reading={reading}
          onDrop={transfer => {
            setReading(true)
            droppedFiles(transfer).then(choose, () => toast({ title: 'That could not be read', description: 'Try choosing the folder instead.' })).finally(() => setReading(false))
          }}
          onPick={files => choose(pickedFiles(files))}
          onStart={() => void upload?.start()}
          onPause={() => upload?.pause()}
          onCancel={() => {
            void upload?.cancel()
            setActive(null)
            toast({ title: 'Upload cancelled', description: 'Nothing from it was kept.' })
          }}
          onClear={() => setActive(null)}
        />
      )}

      <section aria-labelledby="recent-imports">
        <SectionHeader id="recent-imports" title={isAdmin ? 'Recent imports' : 'Your imports'} />
        <ImportsList imports={recent.data} ownerOf={ownerOf} onCancel={item => cancelImport.mutate(item)} />
      </section>
    </Page>
  )
}

export function ImportPage() {
  const id = useParams().id ?? ''
  const user = useCurrentUser()
  useImportEvents()
  const { item, albums } = useImport(id)
  const ownerOf = useOwners()
  const cancelImport = useCancelImport()
  if (item.error) return isNotFound(item.error) || (item.error instanceof ApiError && item.error.code === 'invalid_request') ? <NotFoundPage /> : <Page><EmptyState icon={<UploadIcon />} title="This import did not load" description={item.error.message} className="pt-24" /></Page>
  return (
    <Page className="flex max-w-4xl flex-col gap-6">
      <div>
        <Link to="/imports" className="mb-2 inline-flex items-center gap-1 text-[13px] font-semibold text-muted hover:text-foreground"><ChevronLeft className="size-4" />Add music</Link>
        <PageTitle>Import</PageTitle>
      </div>
      {item.data
        ? <ImportDetail item={item.data} owner={ownerOf(item.data)} albums={albums} isAdmin={user.role === 'admin'} onCancel={() => cancelImport.mutate(item.data)} />
        : <Skeleton className="h-64 rounded-2xl" />}
    </Page>
  )
}
