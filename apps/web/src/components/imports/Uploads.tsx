import { formatDuration } from '@squirmy/client-core'
import type { UploadAlbum, UploadFile, UploaderFilter } from '@squirmy/contracts'
import { ChevronDown, Disc3, MoreHorizontal, Trash2, Upload as UploadIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useNote } from '@/components/admin/note'
import { InlineNote } from '@/components/admin/Panel'
import { Cover } from '@/components/music/Cover'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/dialog'
import { EmptyState, Skeleton, Spinner } from '@/components/ui/feedback'
import { IconButton } from '@/components/ui/icon-button'
import { DropdownMenu } from '@/components/ui/menu'
import { Select, type SelectOption } from '@/components/ui/select'
import { formatBytes, formatRelative, plural } from '@/lib/format'
import { uploadKey } from '@/lib/imports'
import { cn } from '@/lib/utils'

/** Whose upload it is, for admins: `@name`, or the inbox folder's. */
const uploaderLabel = (item: Pick<UploadAlbum, 'uploader'>) => (item.uploader ? `@${item.uploader.username}` : 'Inbox')

/** An album's songs as the page has them: loading (undefined), loaded, or failed with a way to ask again. */
export type UploadSongs = { files?: UploadFile[]; failure?: ReactNode }

/** What a deletion came to, for the note it leaves. */
export type DeleteResult = { deletedFiles: number; deletedBytes: number; keptFiles: number }

export type UploadsViewProps = {
  /** Admins see everyone's uploads, with who uploaded each and a filter by uploader. */
  admin: boolean
  /** Undefined while loading. */
  albums: UploadAlbum[] | undefined
  /** Said in place of the list when its first page did not load. */
  failure?: ReactNode
  /** More albums are on the server; `load` asks for them. */
  more?: { loading: boolean; load: () => void }
  /** Admins: the uploaders to filter by, and the one chosen (`all` for everyone). */
  uploaders?: SelectOption<UploaderFilter | 'all'>[]
  uploader?: UploaderFilter | 'all'
  onUploaderChange?: (uploader: UploaderFilter | 'all') => void
  /** The albums showing their songs, by `uploadKey`. */
  expanded: ReadonlySet<string>
  onToggle: (item: UploadAlbum) => void
  songs: (item: UploadAlbum) => UploadSongs
  onDeleteAlbum: (item: UploadAlbum) => Promise<DeleteResult>
  onDeleteFile: (item: UploadAlbum, file: UploadFile) => Promise<DeleteResult>
}

/** What a deletion did, said on the page once the confirmation closes. */
function deletedNote(result: DeleteResult): string {
  const deleted = `Deleted ${plural(result.deletedFiles, 'song')} (${formatBytes(result.deletedBytes)}) from the server.`
  return result.keptFiles > 0 ? `${deleted} ${plural(result.keptFiles, 'file')} could not be deleted and ${result.keptFiles === 1 ? 'was' : 'were'} kept.` : deleted
}

type Pending = { kind: 'album'; item: UploadAlbum } | { kind: 'file'; item: UploadAlbum; file: UploadFile }

/**
 * Uploaded music by album, newest first: its cover, songs, size and when it arrived, opening
 * to its songs. Deleting an album or a song asks first, because it takes the files off the
 * server for everyone and cannot be undone.
 */
export function UploadsView(props: UploadsViewProps) {
  const { admin, albums, failure, more, uploaders, uploader, onUploaderChange } = props
  const [pending, setPending] = useState<Pending | null>(null)
  const { note, setNote } = useNote()
  const confirm = async () => {
    if (!pending) return
    const result = pending.kind === 'album' ? await props.onDeleteAlbum(pending.item) : await props.onDeleteFile(pending.item, pending.file)
    setNote({ tone: result.keptFiles > 0 && result.deletedFiles === 0 ? 'error' : 'info', text: deletedNote(result) })
  }
  const toDelete = pending?.kind === 'album' ? pending.item.album.title : pending?.file.track?.title ?? pending?.file.title

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="max-w-2xl flex-1 text-sm text-muted-foreground">
          {admin
            ? 'Music people uploaded, and music from the inbox folder. Deleting it takes the files off the server for everyone.'
            : 'Music you uploaded. It is on the server for everyone, and in your library until you take it out. Deleting it takes the files off the server for everyone.'}
        </p>
        {admin && uploaders && onUploaderChange && (
          <Select label="Uploaded by" prefix="Uploaded by:" value={uploader ?? 'all'} options={uploaders} onValueChange={onUploaderChange} size="sm" />
        )}
      </div>
      <InlineNote note={note} className="text-sm" />

      {albums === undefined
        ? failure ?? <UploadsSkeleton />
        : albums.length === 0
          ? (
            <EmptyState
              icon={<UploadIcon />}
              title={admin ? 'No uploads' : 'You haven’t uploaded anything yet'}
              description={admin ? 'Uploaded music and music from the inbox folder show up here once it is filed.' : 'Albums you upload show up here once the server has filed them.'}
              action={admin ? undefined : <Button asChild variant="primary"><Link to="/imports"><UploadIcon />Add music</Link></Button>}
              className="rounded-xl border py-10"
            />
          )
          : (
            <ul aria-label={admin ? 'Uploads' : 'Your uploads'} className="divide-y overflow-hidden rounded-xl border bg-card">
              {albums.map(item => (
                <UploadAlbumRow
                  key={uploadKey(item)}
                  item={item}
                  admin={admin}
                  open={props.expanded.has(uploadKey(item))}
                  songs={props.expanded.has(uploadKey(item)) ? props.songs(item) : undefined}
                  onToggle={() => props.onToggle(item)}
                  onDelete={() => setPending({ kind: 'album', item })}
                  onDeleteFile={file => setPending({ kind: 'file', item, file })}
                />
              ))}
            </ul>
          )}
      {more && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" pending={more.loading} onClick={more.load}>Show more</Button>
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={open => { if (!open) setPending(null) }}
        title={`Delete “${toDelete ?? ''}”?`}
        description={pending?.kind === 'album'
          ? `This deletes ${plural(pending.item.fileCount, 'uploaded song')} (${formatBytes(pending.item.bytes)}) from the server, for everyone who listens here. It can’t be undone.`
          : 'This deletes the song’s file from the server, for everyone who listens here. It can’t be undone.'}
        confirmLabel={pending?.kind === 'album' ? 'Delete album' : 'Delete song'}
        onConfirm={confirm}
      />
    </div>
  )
}

type UploadAlbumRowProps = {
  item: UploadAlbum
  admin: boolean
  open: boolean
  songs: UploadSongs | undefined
  onToggle: () => void
  onDelete: () => void
  onDeleteFile: (file: UploadFile) => void
}

function UploadAlbumRow({ item, admin, open, songs, onToggle, onDelete, onDeleteFile }: UploadAlbumRowProps) {
  const { album } = item
  const songsId = `upload-songs-${uploadKey(item)}`
  return (
    <li>
      <div className="flex items-center gap-3 px-4 py-2.5">
        {album.artwork
          ? <Cover artwork={album.artwork} size={96} className="size-11 rounded-md" />
          : <div className="flex size-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Disc3 className="size-5" /></div>}
        <div className="min-w-0 flex-1">
          <Link to={`/album/${album.id}`} className="block truncate text-sm font-medium outline-none hover:underline focus-visible:underline">{album.title}</Link>
          <p className="truncate text-xs text-muted-foreground">
            {[album.artistCredit, admin ? uploaderLabel(item) : null, plural(item.fileCount, 'song'), formatBytes(item.bytes), `uploaded ${formatRelative(item.uploadedAt)}`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <IconButton label={open ? `Hide the songs of ${album.title}` : `Show the songs of ${album.title}`} size="sm" aria-expanded={open} aria-controls={songsId} onClick={onToggle}>
          <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
        </IconButton>
        <DropdownMenu
          entries={[{ label: 'Delete album', icon: <Trash2 />, danger: true, onSelect: onDelete }]}
          trigger={<IconButton label={`More options for ${album.title}`} size="sm"><MoreHorizontal /></IconButton>}
        />
      </div>
      {open && (
        <div id={songsId} className="border-t bg-muted/30 px-4 py-2">
          {songs?.files
            ? (
              <ol aria-label={`Uploaded songs of ${album.title}`} className="flex flex-col">
                {songs.files.map(file => (
                  <li key={file.fileId} className="flex items-center gap-3 py-1.5 pl-14 text-sm">
                    <span className="min-w-0 flex-1 truncate">{file.track?.title ?? file.title}</span>
                    <span className="hidden shrink-0 text-xs uppercase text-muted-foreground sm:inline">{file.codec}</span>
                    <span className="shrink-0 text-xs tabular text-muted-foreground">{formatBytes(file.bytes)}</span>
                    <span className="w-10 shrink-0 text-right text-xs tabular text-muted-foreground">{formatDuration(file.durationMs)}</span>
                    <IconButton label={`Delete ${file.track?.title ?? file.title}`} size="sm" onClick={() => onDeleteFile(file)}><Trash2 /></IconButton>
                  </li>
                ))}
              </ol>
            )
            : songs?.failure ?? <div className="flex justify-center py-3"><Spinner /></div>}
        </div>
      )}
    </li>
  )
}

function UploadsSkeleton() {
  return (
    <div className="divide-y rounded-xl border bg-card">
      {[0, 1, 2].map(index => (
        <div key={index} className="flex items-center gap-3 px-4 py-2.5">
          <Skeleton className="size-11 rounded-md" />
          <div className="flex flex-1 flex-col gap-1.5 py-0.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-64 max-w-full" /></div>
        </div>
      ))}
    </div>
  )
}
