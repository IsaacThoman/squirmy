/**
 * Managing uploaded music: Your uploads for everyone who may upload, and the admin's Uploads
 * with everyone's. A separate download, like the import pages.
 */
import { queryKeys, type UploadAlbum, type UploaderFilter, type UploadFile } from '@squirmy/contracts'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { itemsOf, useUploads, type UploadsScope } from '@/api/queries'
import { useApi } from '@/api/services'
import { useCurrentUser } from '@/auth/session'
import { Page, PageHeader } from '@/components/layout/Page'
import { UploadsView, type UploadSongs } from '@/components/imports/Uploads'
import { LoadError } from '@/components/ui/query-state'
import { loadFailure } from '@/components/ui/load-failure'
import type { SelectOption } from '@/components/ui/select'
import { usePageTitle } from '@/lib/document-title'
import { uploadKey } from '@/lib/imports'

const songsKey = (scope: UploadsScope, item: UploadAlbum) =>
  [...(scope.admin ? queryKeys.adminUploads() : queryKeys.uploads()), 'album', item.album.id, item.uploader?.id ?? 'inbox'] as const

/** Whose files an admin's album row stands for: its uploader's, or the inbox's. */
const uploaderOf = (item: UploadAlbum): UploaderFilter => item.uploader?.id ?? 'inbox'

/** The list, the songs of the albums opened, and the deletes, for one scope. */
function UploadsManager({ scope, uploaders, onUploaderChange }: {
  scope: UploadsScope
  uploaders?: SelectOption<UploaderFilter | 'all'>[]
  onUploaderChange?: (uploader: UploaderFilter | 'all') => void
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const list = useUploads(scope)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const albums = list.data ? itemsOf(list.data) : undefined
  const opened = (albums ?? []).filter(item => expanded.has(uploadKey(item)))
  const songs = useQueries({
    queries: opened.map(item => ({
      queryKey: songsKey(scope, item),
      queryFn: () => (scope.admin ? api.uploads.adminAlbum(item.album.id, { uploader: uploaderOf(item) }) : api.uploads.album(item.album.id)),
    })),
  })
  const songsByKey = new Map(opened.map((item, index) => [uploadKey(item), songs[index]!]))

  // The server announces deletions to every client; this page refreshes its own lists at once.
  const refresh = () => queryClient.invalidateQueries({ queryKey: scope.admin ? queryKeys.adminUploads() : queryKeys.uploads() })
  const deleteAlbum = async (item: UploadAlbum) => {
    const result = scope.admin ? await api.uploads.adminDeleteAlbum(item.album.id, { uploader: uploaderOf(item) }) : await api.uploads.deleteAlbum(item.album.id)
    await refresh()
    return result
  }
  const deleteFile = async (_item: UploadAlbum, file: UploadFile) => {
    const result = scope.admin ? await api.uploads.adminDeleteFile(file.fileId) : await api.uploads.deleteFile(file.fileId)
    await refresh()
    return result
  }

  return (
    <UploadsView
      admin={scope.admin}
      albums={list.error && !list.data ? undefined : albums}
      failure={list.error && !list.data ? <LoadError title="The uploads did not load" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} /> : undefined}
      more={list.hasNextPage && !list.isPlaceholderData ? { loading: list.isFetchingNextPage, load: () => void list.fetchNextPage() } : undefined}
      uploaders={uploaders}
      uploader={scope.admin ? scope.uploader ?? 'all' : undefined}
      onUploaderChange={onUploaderChange}
      expanded={expanded}
      onToggle={item => setExpanded(current => {
        const next = new Set(current)
        if (!next.delete(uploadKey(item))) next.add(uploadKey(item))
        return next
      })}
      songs={(item): UploadSongs => {
        const query = songsByKey.get(uploadKey(item))
        if (!query) return {}
        if (query.data) return { files: query.data.items }
        return { failure: loadFailure(query, 'The songs did not load') ?? undefined }
      }}
      onDeleteAlbum={deleteAlbum}
      onDeleteFile={deleteFile}
    />
  )
}

/** `/uploads`: the music the user uploaded. */
export function UploadsPage() {
  usePageTitle('Your uploads')
  return (
    <>
      <PageHeader title="Your uploads" />
      <Page className="max-w-4xl"><UploadsManager scope={{ admin: false }} /></Page>
    </>
  )
}

/** `/admin/uploads`: everyone's uploads and the inbox's, with a filter by uploader in the URL (`?uploader=`). */
export function AdminUploadsPage() {
  const api = useApi()
  const me = useCurrentUser()
  const [params, setParams] = useSearchParams()
  const chosen = params.get('uploader')
  const uploader: UploaderFilter | undefined = chosen === 'inbox' || (chosen && /^[0-9a-f-]{36}$/i.test(chosen)) ? chosen : undefined
  const users = useQuery({ queryKey: queryKeys.adminUsers(), queryFn: () => api.admin.users() })
  const options: SelectOption<UploaderFilter | 'all'>[] = [
    { value: 'all', label: 'Everyone' },
    ...(users.data?.items ?? []).filter(user => user.canUpload || user.role === 'admin')
      .map(user => ({ value: user.id, label: user.id === me.id ? `${user.displayName ?? user.username} (you)` : user.displayName ?? user.username })),
    { value: 'inbox', label: 'Inbox folder' },
  ]
  // A user no longer listed (uploading switched off) is still a valid filter from a link.
  if (uploader && !options.some(option => option.value === uploader)) options.splice(options.length - 1, 0, { value: uploader, label: 'Someone else' })
  return (
    <UploadsManager
      // Each filter is its own list, with its own songs opened.
      key={uploader ?? 'all'}
      scope={{ admin: true, uploader }}
      uploaders={options}
      onUploaderChange={next => setParams(next === 'all' ? {} : { uploader: next }, { replace: true })}
    />
  )
}
