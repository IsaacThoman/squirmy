import { API_PREFIX, editableCreditRoles, queryKeys, TagEdit, type TagEditor as Editor, type TrackTagPatch } from '@squirmy/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState, type FormEvent } from 'react'
import { errorMessage } from '@/api/errors'
import { useApi } from '@/api/services'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, FormError, Input } from '@/components/ui/input'
import { loadFailure } from '@/components/ui/load-failure'
import { Select } from '@/components/ui/select'
import { DataTable, FolderPath, Panel, Td, Th, Tr } from './Panel'

const albumFields = { album: 'Album', albumArtist: 'Album artist', date: 'Release date', genres: 'Genre', discTotal: 'Disc total' } as const
const trackFields = { title: 'Title', artist: 'Artist', disc: 'Disc', track: 'Track', composer: 'Composer', lyricist: 'Lyricist', arranger: 'Arranger', producer: 'Producer' } as const
const albumKeys = Object.keys(albumFields) as (keyof typeof albumFields)[]
const trackKeys = Object.keys(trackFields) as (keyof typeof trackFields)[]
const coverModes = [
  { value: 'folder', label: 'Folder cover' },
  { value: 'embedded', label: 'Embed in each file' },
  { value: 'both', label: 'Folder and embedded' },
] as const
const compilationOptions = [
  { value: 'unchanged', label: 'Keep existing tags' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
] as const
type Entry = Editor['tracks'][number]
type Cover = NonNullable<TagEdit['cover']>

function display(value: string | number | string[] | null | undefined) {
  return Array.isArray(value) ? value.join('; ') : String(value ?? '')
}

function parseTrack(key: keyof TrackTagPatch, value: string) {
  if (key === 'track' || key === 'disc') return value.trim() ? Number(value) : null
  if (key !== 'title' && key !== 'artist') return splitValues(value)
  return value
}

const splitValues = (value: string) => value.split(';').map(item => item.trim()).filter(Boolean)

export function TagEditor({ albumId, onClose }: { albumId: string; onClose: () => void }) {
  const api = useApi()
  const result = useQuery({ queryKey: [...queryKeys.admin(), 'album-tags', albumId], queryFn: () => api.admin.albumTags(albumId) })
  const [saving, setSaving] = useState(false)
  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) onClose() }}>
      <DialogContent title="Edit tags" description="Edit the tags in this album’s audio files." className="sm:max-w-5xl">
        {result.data
          ? <TagForm albumId={albumId} data={result.data} onClose={onClose} setSaving={setSaving} />
          : loadFailure(result, 'The tags did not load') ?? <p role="status" className="text-sm text-muted-foreground">Loading tags…</p>}
      </DialogContent>
    </Dialog>
  )
}

function TagForm({ albumId, data, onClose, setSaving }: { albumId: string; data: Editor; onClose: () => void; setSaving: (saving: boolean) => void }) {
  const api = useApi()
  const cache = useQueryClient()
  const fieldId = useId()
  const editable = data.tracks.filter(row => !row.reason)
  const [album, setAlbum] = useState<Partial<Record<keyof typeof albumFields, string>>>({})
  const [compilation, setCompilation] = useState<'unchanged' | 'yes' | 'no'>('unchanged')
  const [tracks, setTracks] = useState<Record<string, Partial<Record<keyof TrackTagPatch, string>>>>({})
  const [image, setImage] = useState<Cover['image']>()
  const [upload, setUpload] = useState<File>()
  const [mode, setMode] = useState<Cover['mode']>('folder')
  const [error, setError] = useState<string>()
  const [looking, setLooking] = useState(false)
  const candidates = useQuery({
    queryKey: [...queryKeys.admin(), 'tag-covers', albumId], queryFn: () => api.admin.tagCovers(albumId), enabled: looking,
  })
  const covers = [...new Map([...data.covers, ...(looking ? candidates.data ?? [] : [])].map(cover => [cover.id, cover])).values()]
  const mutation = useMutation({
    mutationFn: (body: TagEdit) => api.admin.editAlbumTags(albumId, body),
    onSuccess: () => void cache.invalidateQueries({ queryKey: queryKeys.album(albumId) }),
  })
  const trackValue = (row: Entry, key: keyof TrackTagPatch) => tracks[row.id]?.[key] ?? display(row.tags[key])
  const albumDefaults = (key: keyof typeof albumFields) => new Set(editable.map(row => display(row.tags[key])))
  const changeTrack = (id: string, key: keyof TrackTagPatch, value: string) =>
    setTracks(current => ({ ...current, [id]: { ...current[id], [key]: value } }))

  function capitalize() {
    setTracks(current => {
      const next = { ...current }
      for (const row of editable) {
        const title = trackValue(row, 'title')
        const capitalized = title.replace(/(^|[\s-])(\p{L})/gu, (_match, before: string, letter: string) => before + letter.toLocaleUpperCase())
        if (capitalized !== title) next[row.id] = { ...current[row.id], title: capitalized }
      }
      return next
    })
  }

  function renumber() {
    const ordered = [...editable].sort((a, b) => Number(trackValue(a, 'track') || Infinity) - Number(trackValue(b, 'track') || Infinity))
    const counts = new Map<string, number>()
    setTracks(current => {
      const next = { ...current }
      for (const row of ordered) {
        const disc = row.group + '/' + (Number(trackValue(row, 'disc')) || 1)
        const track = (counts.get(disc) ?? 0) + 1
        counts.set(disc, track)
        next[row.id] = { ...current[row.id], track: String(track) }
      }
      return next
    })
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setError(undefined)
    setSaving(true)
    try {
      let replacement = image
      if (upload) {
        if (upload.size > 6 * 1024 * 1024) throw new Error('Choose a cover image smaller than 6 MB.')
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
          reader.onerror = () => reject(new Error('The image could not be read.'))
          reader.readAsDataURL(upload)
        })
        replacement = { base64 }
      }
      const albumTags = {
        ...album,
        ...(album.date !== undefined && { date: album.date.trim() || null }),
        ...(album.genres !== undefined && { genres: splitValues(album.genres) }),
        ...(album.discTotal !== undefined && { discTotal: album.discTotal.trim() ? Number(album.discTotal) : null }),
        ...(compilation !== 'unchanged' && { compilation: compilation === 'yes' }),
      }
      const draft = {
        album: albumTags,
        tracks: editable.map(row => ({
          id: row.id, revision: row.revision,
          tags: Object.fromEntries(Object.entries(tracks[row.id] ?? {}).map(([key, value]) => [key, parseTrack(key as keyof TrackTagPatch, value)])),
        })).filter(row => Object.keys(albumTags).length || replacement || Object.keys(row.tags).length),
        ...(replacement && { cover: { mode, image: replacement } }),
      }
      const valid = TagEdit.safeParse(draft)
      if (!valid.success) {
        setError('Check the release date (YYYY, YYYY-MM or YYYY-MM-DD), numbers (1–9999), and tag lengths.')
        return
      }
      const result = await mutation.mutateAsync(valid.data)
      if (!result.errors.length) onClose()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setSaving(false)
    }
  }

  const unavailable = data.tracks.filter(row => row.reason)
  const changed = Object.keys(album).length > 0 || compilation !== 'unchanged' || Object.keys(tracks).length > 0 || !!image || !!upload
  const errors = mutation.data?.errors ?? []
  return (
    <form onSubmit={event => void save(event)} className="flex flex-col gap-5">
      <fieldset disabled={mutation.isPending || errors.length > 0} className="flex min-w-0 flex-col gap-5">
        {editable.length > 0 && (
          <>
            <Panel title="Album tags" description="Changes here apply to every editable copy. Separate multiple genres with semicolons.">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {albumKeys.map(key => {
                  const values = albumDefaults(key)
                  return (
                    <Field key={key} label={albumFields[key]} htmlFor={fieldId + key}>
                      <Input id={fieldId + key} type={key === 'discTotal' ? 'number' : 'text'} min={1} max={9999}
                        placeholder={values.size > 1 ? 'Multiple values' : key === 'date' ? 'YYYY-MM-DD' : undefined}
                        value={album[key] ?? (values.size === 1 ? [...values][0] : '')}
                        onChange={event => setAlbum({ ...album, [key]: event.target.value })} />
                    </Field>
                  )
                })}
                <Field label="Compilation" htmlFor={fieldId + 'compilation'}>
                  <Select id={fieldId + 'compilation'} label="Compilation" options={compilationOptions} value={compilation} onValueChange={setCompilation} />
                  {compilation === 'unchanged' && <span className="text-xs text-muted-foreground">
                    {new Set(editable.map(row => !!row.tags.compilation)).size > 1 ? 'Multiple values' : editable[0]?.tags.compilation ? 'Currently yes' : 'Currently no'}
                  </span>}
                </Field>
              </div>
            </Panel>
            <Panel title="Tracks" description="Separate multiple credits with semicolons. Scroll to see all columns."
              action={<><Button type="button" size="sm" variant="outline" onClick={capitalize}>Capitalize titles</Button>
                <Button type="button" size="sm" variant="outline" onClick={renumber}>Renumber by disc</Button></>}>
              <DataTable>
                <thead><tr>{trackKeys.map(key => <Th key={key}>{trackFields[key]}</Th>)}<Th>File</Th></tr></thead>
                <tbody>{editable.map(row => <Tr key={row.id}>
                  {trackKeys.map(key => (
                    <Td key={key}><Input aria-label={`${trackFields[key]} for ${row.tags.title ?? row.path}`}
                      className={key === 'disc' || key === 'track' ? 'w-16 px-1.5' : editableCreditRoles.some(role => role === key) ? 'w-32' : 'w-44'}
                      type={key === 'disc' || key === 'track' ? 'number' : 'text'} min={1} max={9999}
                      value={trackValue(row, key)} onChange={event => changeTrack(row.id, key, event.target.value)} /></Td>
                  ))}
                  <Td>
                    <FolderPath className="max-w-56" path={row.path} />
                    {row.matchLocked && <span className="text-xs text-muted-foreground">Match locked</span>}
                  </Td>
                </Tr>)}</tbody>
              </DataTable>
            </Panel>
            <Panel title="Cover art" action={<Button type="button" size="sm" variant="outline" disabled={candidates.isFetching}
              onClick={() => { if (looking) void candidates.refetch(); else setLooking(true) }}>Find covers</Button>}>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="Upload cover" htmlFor={fieldId + 'cover'}>
                  <Input key={image && 'assetId' in image ? image.assetId : 'file'} id={fieldId + 'cover'} type="file" accept="image/*"
                    onChange={event => { setUpload(event.target.files?.[0]); setImage(undefined) }} />
                </Field>
                <Field label="Write cover to" htmlFor={fieldId + 'cover-mode'}>
                  <Select id={fieldId + 'cover-mode'} label="Write cover to" options={coverModes} value={mode} onValueChange={setMode} />
                </Field>
                {(upload || image) && <Button variant="ghost" type="button" onClick={() => { setUpload(undefined); setImage(undefined) }}>Clear selection</Button>}
              </div>
              {looking && (loadFailure(candidates, 'Cover search failed') ?? (candidates.isFetching
                ? <p role="status" className="text-xs text-muted-foreground">Finding covers…</p>
                : !candidates.data?.length && <p className="text-xs text-muted-foreground">No additional covers found.</p>))}
              <div className="flex flex-wrap gap-2">
                {covers.map((cover, index) => (
                  <Button key={cover.id} type="button" variant={image && 'assetId' in image && image.assetId === cover.id ? 'primary' : 'outline'}
                    className="size-20 p-1" aria-label={`Use cover ${index + 1}${cover.width ? `, ${cover.width} pixels wide` : ''}`}
                    aria-pressed={!!image && 'assetId' in image && image.assetId === cover.id}
                    onClick={() => { setUpload(undefined); setImage({ assetId: cover.id }) }}>
                    <img alt="" className="size-full rounded-sm object-cover" src={`${API_PREFIX}/art/${cover.id}/96.webp`} />
                  </Button>
                ))}
              </div>
            </Panel>
          </>
        )}
        {unavailable.length > 0 && <Panel title="Files you can’t edit">
          <ul className="space-y-2">{unavailable.map(row => <li key={row.id} className="text-sm">{row.reason}<FolderPath path={row.path} /></li>)}</ul>
        </Panel>}
        {!data.tracks.length && <p className="text-sm text-muted-foreground">This album has no collection files to edit.</p>}
      </fieldset>
      {errors.length > 0 && <div role="alert" className="space-y-1 text-sm text-destructive">
        <p>Saved changes to {mutation.data?.written.length ?? 0} files. Reopen the editor to retry.</p>
        {errors.map((item, index) => <p key={index} className="break-all">{item.path} · {item.reason}</p>)}
      </div>}
      <FormError message={error} />
      <DialogFooter>
        <Button type="button" variant="outline" disabled={mutation.isPending} onClick={onClose}>{errors.length || !editable.length ? 'Close' : 'Cancel'}</Button>
        {!!editable.length && !errors.length && <Button type="submit" pending={mutation.isPending} disabled={!changed}>Save tags</Button>}
      </DialogFooter>
    </form>
  )
}
