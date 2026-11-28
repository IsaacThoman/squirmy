import { useMovePlaylistToFolder, usePlaylistFolders } from '@/api/playlist-folders'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { API_PREFIX, PlaylistFolderRequest, queryKeys, type PlaylistCollaboratorRole, type PlaylistDetail, type PlaylistFolder, type PlaylistImportResult } from '@squirmy/contracts'
import { Folder, Trash2 } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { Link } from 'react-router'
import { errorMessage, useFormSubmit } from '@/api/errors'
import { useApi } from '@/api/services'
import { Button } from '@/components/ui/button'
import { ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { IconButton } from '@/components/ui/icon-button'
import { Field, FormError, Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { draggedMusic } from '@/lib/drag'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

type FolderTargetProps = ComponentProps<'button'> & {
  folderId: string | null
  canMove: (id: string) => boolean
  onMove: (id: string, folderId: string | null) => Promise<unknown>
}

/** The same drop target works with playlist cards and with the sidebar's links. */
export function FolderTarget({ folderId, canMove, onMove, className, children, ...button }: FolderTargetProps) {
  const [over, setOver] = useState(false)
  const [failure, setFailure] = useState<string>()
  const candidate = (event: Parameters<NonNullable<ComponentProps<'button'>['onDrop']>>[0]) => {
    const drag = draggedMusic(event)
    return drag?.kind === 'collection' && drag.collection.kind === 'playlist' && canMove(drag.collection.id) ? drag.collection.id : null
  }
  return <div className="min-w-0">
    <button type="button" {...button} className={cn(className, over && 'bg-accent ring-2 ring-primary')}
      onDragOver={event => {
        if (!candidate(event)) return
        event.preventDefault()
        // Playlist drags also work as copies onto the queue and other playlists.
        event.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={event => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false)
      }}
      onDrop={event => {
        setOver(false)
        const id = candidate(event)
        if (!id) return
        event.preventDefault()
        setFailure(undefined)
        void onMove(id, folderId).catch(error => setFailure(errorMessage(error)))
      }}>{children}</button>
    <FormError message={failure} />
  </div>
}

export function NewPlaylistFolderDialog({ onClose }: { onClose: () => void }) {
  const api = useApi()
  const cache = useQueryClient()
  const [name, setName] = useState('')
  const form = useFormSubmit(PlaylistFolderRequest, async body => {
    const folder = await api.userdata.createPlaylistFolder(body)
    cache.setQueryData<PlaylistFolder[]>(queryKeys.playlistFolders(), previous =>
      [...(previous ?? []).filter(value => value.id !== folder.id), folder].sort((a, b) => a.name.localeCompare(b.name)))
  })
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent title="New playlist folder">
      <form className="space-y-4" onSubmit={event => {
        event.preventDefault()
        void form.submit({ name }).then(ok => { if (ok) onClose() })
      }}>
        <Field label="Name" htmlFor="playlist-folder-name" error={form.errors.name}>
          <Input id="playlist-folder-name" value={name} onChange={event => setName(event.target.value)} maxLength={120} autoFocus />
        </Field>
        <FormError message={form.errors.form} />
        <DialogFooter>
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button type="submit" variant="primary" disabled={!name.trim()} pending={form.pending}>Create</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

export function ImportPlaylistDialog({ onClose }: { onClose: () => void }) {
  const api = useApi()
  const cache = useQueryClient()
  const [file, setFile] = useState<File>()
  const [result, setResult] = useState<PlaylistImportResult>()
  const importFile = useMutation({
    mutationFn: (file: File) => api.userdata.importPlaylist({ data: file, name: file.name }),
    onSuccess: answer => {
      setResult(answer)
      void cache.invalidateQueries({ queryKey: queryKeys.playlists() })
    },
  })
  return <Dialog open onOpenChange={open => { if (!open && !importFile.isPending) onClose() }}>
    <DialogContent title={result ? 'Playlist imported' : 'Import playlist'}
      description={result ? result.playlist.name : 'Choose a UTF-8 M3U, M3U8, XSPF, text list or Exportify CSV file.'}>
      {result ? <>
        <p role="status" className="text-sm">{plural(result.matched, 'song')} added. {result.unmatched.length} unmatched.</p>
        {result.unmatched.length > 0 && <ul aria-label="Unmatched entries" className="max-h-56 space-y-1 overflow-auto rounded-md border p-3 text-sm text-muted-foreground">
          {result.unmatched.map((entry, index) => <li key={index}>Line {entry.line} · {entry.text}</li>)}
        </ul>}
        <DialogFooter><Button variant="primary" asChild><Link onClick={onClose} to={`/playlist/${result.playlist.id}`}>Open playlist</Link></Button></DialogFooter>
      </> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (file) importFile.mutate(file) }}>
        <Field label="Playlist file" htmlFor="playlist-import-file">
          <Input id="playlist-import-file" type="file" accept=".m3u,.m3u8,.xspf,.txt,.csv"
            onChange={event => setFile(event.target.files?.[0])} disabled={importFile.isPending} />
        </Field>
        <FormError message={importFile.error ? errorMessage(importFile.error) : undefined} />
        <DialogFooter>
          <DialogClose asChild><Button variant="outline" disabled={importFile.isPending}>Cancel</Button></DialogClose>
          <Button type="submit" variant="primary" pending={importFile.isPending} disabled={!file}>Import</Button>
        </DialogFooter>
      </form>}
    </DialogContent>
  </Dialog>
}

const permissions = [{ value: 'edit' as const, label: 'Can edit songs' }, { value: 'add' as const, label: 'Add only' }]

export function CollaboratorsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi()
  const cache = useQueryClient()
  const [search, setSearch] = useState('')
  const [person, setPerson] = useState('')
  const [role, setRole] = useState<PlaylistCollaboratorRole>('edit')
  const key = [...queryKeys.playlist(id), 'collaborators']
  const members = useQuery({ queryKey: key, queryFn: () => api.userdata.playlistCollaborators(id) })
  const people = useQuery({
    queryKey: [...queryKeys.playlist(id), 'people', search],
    queryFn: ({ signal }) => api.userdata.playlistPeople(id, search.trim(), { signal }),
  })
  const candidates = (people.data ?? []).filter(candidate => !members.data?.some(member => member.id === candidate.id))
  const change = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: PlaylistCollaboratorRole | null }) => role
      ? api.userdata.setPlaylistCollaborator(id, userId, role)
      : api.userdata.removePlaylistCollaborator(id, userId),
    onSuccess: async () => {
      setPerson('')
      await Promise.all([cache.invalidateQueries({ queryKey: key }), cache.invalidateQueries({ queryKey: queryKeys.playlist(id), exact: true })])
    },
  })
  const failure = change.error ?? members.error ?? people.error
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent title="Collaborators" description="Invite people on this server to add songs. Editors can also remove and reorder songs.">
      {members.data && members.data.length > 0 && <ul className="max-h-48 space-y-2 overflow-auto">
        {members.data.map(member => <li key={member.id} className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{member.name} <span className="text-muted-foreground">@{member.username}</span></span>
          <Select label={`Permission for ${member.name}`} value={member.role} options={permissions} disabled={change.isPending}
            onValueChange={role => change.mutate({ userId: member.id, role })} />
          <IconButton label={`Remove ${member.name}`} disabled={change.isPending} onClick={() => change.mutate({ userId: member.id, role: null })}><Trash2 /></IconButton>
        </li>)}
      </ul>}
      <Field label="Find a person" htmlFor="playlist-person-search">
        <Input id="playlist-person-search" value={search} maxLength={120} placeholder="Name or username"
          onChange={event => { setSearch(event.target.value); setPerson('') }} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Select label="Person to invite" value={person || 'none'} options={[{ value: 'none', label: people.isPending ? 'Loading people…' : candidates.length ? 'Choose person' : 'No people found' },
          ...candidates.map(candidate => ({ value: candidate.id, label: `${candidate.name} (@${candidate.username})` }))]}
          onValueChange={value => setPerson(value === 'none' ? '' : value)} disabled={!members.data || !candidates.length || change.isPending} />
        <Select label="Permission" value={role} options={permissions} onValueChange={setRole} disabled={change.isPending} />
      </div>
      <FormError message={failure ? errorMessage(failure) : undefined} />
      <DialogFooter>
        <DialogClose asChild><Button variant="outline">Done</Button></DialogClose>
        <Button variant="primary" pending={change.isPending} disabled={!person || !candidates.some(candidate => candidate.id === person)}
          onClick={() => change.mutate({ userId: person, role })}>Invite</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function PlaylistCoverDialog({ playlist, onClose }: { playlist: PlaylistDetail; onClose: () => void }) {
  const api = useApi()
  const cache = useQueryClient()
  const [image, setImage] = useState<File>()
  const change = useMutation({
    mutationFn: (file: File | null) => file ? api.userdata.uploadPlaylistCover(playlist.id, { data: file, name: file.name })
      : api.userdata.resetPlaylistCover(playlist.id),
    onSuccess: async summary => {
      cache.setQueryData<PlaylistDetail>(queryKeys.playlist(playlist.id), detail => detail && { ...detail, ...summary })
      await cache.invalidateQueries({ queryKey: queryKeys.playlists() })
      onClose()
    },
  })
  return <Dialog open onOpenChange={open => { if (!open && !change.isPending) onClose() }}>
    <DialogContent title="Playlist cover" description="Upload an image or use the collage made from the playlist’s albums.">
      <Field label="Cover image" htmlFor="playlist-cover-file">
        <Input id="playlist-cover-file" type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/gif,image/tiff"
          onChange={event => setImage(event.target.files?.[0])} disabled={change.isPending} />
      </Field>
      <FormError message={change.error ? errorMessage(change.error) : undefined} />
      <DialogFooter>
        {playlist.customCover && <Button variant="outline" disabled={change.isPending} onClick={() => change.mutate(null)}>Use automatic cover</Button>}
        <Button variant="primary" pending={change.isPending} disabled={!image} onClick={() => { if (image) change.mutate(image) }}>Upload cover</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function ExportPlaylistDialog({ id, onClose }: { id: string; onClose: () => void }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent title="Export playlist" description="File paths are relative to their music library root.">
      <DialogFooter>
        {(['m3u8', 'xspf', 'json'] as const).map(format => <Button key={format} variant="outline" asChild>
          <a href={`${API_PREFIX}/playlists/${encodeURIComponent(id)}/export?format=${format}`} download>{format.toUpperCase()}</a>
        </Button>)}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function DedupePlaylistDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useApi()
  const cache = useQueryClient()
  const [editions, setEditions] = useState(false)
  const remove = useMutation({
    mutationFn: () => api.userdata.dedupePlaylist(id, editions),
    onSuccess: answer => {
      cache.setQueryData(queryKeys.playlist(id), answer.playlist)
      void cache.invalidateQueries({ queryKey: queryKeys.playlists() })
    },
  })
  return <Dialog open onOpenChange={open => { if (!open && !remove.isPending) onClose() }}>
    <DialogContent title="Remove duplicates" description="Keep the first copy of each recording in the playlist.">
      {remove.data ? <p role="status" className="text-sm">{plural(remove.data.removed, 'duplicate')} removed.</p>
        : <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
          Include other editions
          <Switch checked={editions} onCheckedChange={setEditions} disabled={remove.isPending} />
        </label>}
      <FormError message={remove.error ? errorMessage(remove.error) : undefined} />
      <DialogFooter>
        {remove.data ? <DialogClose asChild><Button variant="primary">Done</Button></DialogClose>
          : <Button variant="primary" pending={remove.isPending} onClick={() => remove.mutate()}>Remove duplicates</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function MovePlaylistDialog({ playlist, onClose }: { playlist: PlaylistDetail; onClose: () => void }) {
  const folders = usePlaylistFolders()
  const move = useMovePlaylistToFolder()
  const [selected, setSelected] = useState(playlist.folderId ?? 'root')
  const change = useMutation({ mutationFn: () => move(playlist.id, selected === 'root' ? null : selected), onSuccess: onClose })
  const failure = change.error ?? folders.error
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    <DialogContent title="Move to folder">
      <Select label="Playlist folder" value={selected} onValueChange={setSelected}
        options={[{ value: 'root', label: 'No folder' }, ...(folders.data ?? []).map(folder => ({ value: folder.id, label: folder.name }))]} />
      <FormError message={failure ? errorMessage(failure) : undefined} />
      <DialogFooter><Button variant="primary" pending={change.isPending} disabled={!folders.data || selected === (playlist.folderId ?? 'root')}
        onClick={() => change.mutate()}><Folder />Move</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export function LibraryPlaylistFolders({ folders, selected, canMove, onOpen }: {
  folders: PlaylistFolder[]
  selected?: PlaylistFolder
  canMove: (id: string) => boolean
  onOpen: (id: string | undefined) => void
}) {
  const api = useApi()
  const cache = useQueryClient()
  const move = useMovePlaylistToFolder()
  const [dialog, setDialog] = useState<'new' | 'import' | 'delete' | null>(null)
  const remove = async () => {
    if (!selected) return
    await api.userdata.deletePlaylistFolder(selected.id)
    onOpen(undefined)
    await Promise.all([
      cache.invalidateQueries({ queryKey: queryKeys.playlists() }),
      cache.invalidateQueries({ queryKey: queryKeys.libraryItems() }),
    ])
  }
  return <div className="mb-4 flex flex-wrap items-center gap-2">
    {selected ? <>
      <FolderTarget folderId={null} canMove={canMove} onMove={move} onClick={() => onOpen(undefined)}
        className="rounded-md border px-3 py-2 text-sm hover:bg-accent">All folders</FolderTarget>
      <span className="min-w-0 truncate text-sm font-medium">{selected.name}</span>
      <IconButton label={`Delete folder ${selected.name}`} onClick={() => setDialog('delete')}><Trash2 /></IconButton>
    </> : <>
      {folders.map(folder => <FolderTarget key={folder.id} folderId={folder.id} canMove={canMove} onMove={move} onClick={() => onOpen(folder.id)}
        className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent">
        <Folder className="size-4 text-muted-foreground" aria-hidden />{folder.name}
      </FolderTarget>)}
      <Button variant="ghost" size="sm" onClick={() => setDialog('new')}>New folder</Button>
      <Button variant="ghost" size="sm" onClick={() => setDialog('import')}>Import playlist…</Button>
    </>}
    {dialog === 'new' && <NewPlaylistFolderDialog onClose={() => setDialog(null)} />}
    {dialog === 'import' && <ImportPlaylistDialog onClose={() => setDialog(null)} />}
    {dialog === 'delete' && selected && <ConfirmDialog open onOpenChange={open => { if (!open) setDialog(null) }}
      title={`Delete “${selected.name}”?`} description="Its playlists will move out of the folder." confirmLabel="Delete folder" onConfirm={remove} />}
  </div>
}
