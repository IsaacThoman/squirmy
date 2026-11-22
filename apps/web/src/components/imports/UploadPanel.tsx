import type { ImportOptions, ImportUnavailable } from '@squirmy/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, FileArchive, FileAudio, FolderUp, Pause, Play, Upload, X } from 'lucide-react'
import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { EmptyState, ProgressBar, Skeleton, Spinner } from '@/components/ui/feedback'
import { formatBytes, plural } from '@/lib/format'
import { rejectionLabels } from '@/lib/imports'
import type { UploadFileState, UploadSnapshot } from '@/lib/upload'
import { cn } from '@/lib/utils'

const unavailableText: Record<ImportUnavailable, { admin: ReactNode; member: string }> = {
  no_managed_root: {
    admin: <>Uploads are filed into a managed music folder, and this server has none yet. Add one, or let Squirmy manage an existing folder, in <Link to="/admin/library" className="font-semibold text-accent hover:underline">Library settings</Link>.</>,
    member: 'Uploads are filed into a managed music folder, and this server has none yet. Ask an admin to add one.',
  },
  import_root_not_set: {
    admin: <>This server has several managed folders. Choose the one uploads go to in <Link to="/admin/settings?section=library" className="font-semibold text-accent hover:underline">Server settings</Link>.</>,
    member: 'An admin needs to choose which music folder uploads go to.',
  },
  import_root_unavailable: {
    admin: <>The folder chosen for uploads is disabled, gone, or no longer managed. Choose another in <Link to="/admin/settings?section=library" className="font-semibold text-accent hover:underline">Server settings</Link>.</>,
    member: 'The folder uploads go to is not available. Ask an admin to choose another.',
  },
}

type UploadPanelProps = {
  /** Undefined while loading. */
  options: ImportOptions | undefined
  isAdmin: boolean
  /** The upload being prepared or sent; null before anything is chosen. */
  upload: UploadSnapshot | null
  /** Folders being read after a drop. */
  reading: boolean
  onDrop: (transfer: DataTransfer) => void
  onPick: (files: FileList) => void
  onStart: () => void
  onPause: () => void
  onCancel: () => void
  /** Puts the chosen files away before anything was sent. */
  onClear: () => void
}

/** Choosing music to upload and sending it, with progress for each file and for all of them. */
export function UploadPanel({ options, isAdmin, upload, reading, onDrop, onPick, onStart, onPause, onCancel, onClear }: UploadPanelProps) {
  if (!options) return <Skeleton className="h-72 rounded-3xl" />
  if (options.unavailable) {
    const text = unavailableText[options.unavailable]
    return (
      <div className="rounded-3xl bg-sheet ring-1 ring-stroke">
        <EmptyState icon={<FolderUp />} title="Uploads have nowhere to go yet" description={isAdmin ? undefined : text.member} action={isAdmin ? <p className="max-w-md text-sm leading-relaxed text-muted">{text.admin}</p> : undefined} />
      </div>
    )
  }
  if (!upload) return <DropZone options={options} reading={reading} onDrop={onDrop} onPick={onPick} />
  return <UploadQueue options={options} upload={upload} onStart={onStart} onPause={onPause} onCancel={onCancel} onClear={onClear} onDrop={onDrop} />
}

function DropZone({ options, reading, onDrop, onPick }: { options: ImportOptions; reading: boolean; onDrop: (transfer: DataTransfer) => void; onPick: (files: FileList) => void }) {
  const [over, setOver] = useState(false)
  const files = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const pick = (input: HTMLInputElement) => {
    if (input.files?.length) onPick(input.files)
    input.value = ''
  }
  return (
    <div
      onDragOver={event => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={event => {
        event.preventDefault()
        setOver(false)
        onDrop(event.dataTransfer)
      }}
      className={cn('flex flex-col items-center rounded-3xl border-2 border-dashed px-6 py-14 text-center transition-colors duration-150', over ? 'border-accent bg-selection' : 'border-stroke bg-sheet')}
    >
      <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-selection text-accent [&_svg]:size-6">
        {reading ? <Spinner label="Reading the folder" className="size-6" /> : <Upload />}
      </div>
      <h2 className="text-[19px] font-bold tracking-tight">{reading ? 'Reading the folder…' : 'Drop music here'}</h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
        Album folders, single files or zip archives. Folders keep their structure, and the server identifies and files the albums.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => folder.current?.click()} disabled={reading}><FolderUp />Choose a folder</Button>
        <Button onClick={() => files.current?.click()} disabled={reading}><FileAudio />Choose files</Button>
      </div>
      <p className="mt-4 text-xs text-quiet">Up to {formatBytes(options.maxFileBytes)} per file and {formatBytes(options.maxBytes)} per upload.</p>
      <input ref={files} type="file" multiple hidden aria-label="Music files" onChange={event => pick(event.currentTarget)} />
      <input ref={folder} type="file" hidden aria-label="Music folder" {...{ webkitdirectory: '' }} onChange={event => pick(event.currentTarget)} />
    </div>
  )
}

type UploadQueueProps = Omit<UploadPanelProps, 'options' | 'upload' | 'reading' | 'onPick' | 'isAdmin'> & { options: ImportOptions; upload: UploadSnapshot }

function UploadQueue({ options, upload, onStart, onPause, onCancel, onClear, onDrop }: UploadQueueProps) {
  const { phase, files, totalBytes, sentBytes } = upload
  const rejected = files.filter(file => file.status === 'rejected').length
  const left = files.filter(file => file.status === 'waiting' || file.status === 'sending').length
  const tooBig = totalBytes > options.maxBytes
  const folders = new Set(files.map(file => (file.path.includes('/') ? file.path.split('/')[0] : null)).filter(Boolean)).size
  const sending = phase === 'sending' || phase === 'paused' || (phase === 'failed' && sentBytes > 0)
  return (
    <div
      className="rounded-3xl bg-sheet p-5 ring-1 ring-stroke"
      onDragOver={event => { if (phase === 'ready' && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={event => {
        if (phase !== 'ready') return
        event.preventDefault()
        onDrop(event.dataTransfer)
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[17px] font-bold">{phase === 'ready' ? 'Ready to upload' : phase === 'paused' ? 'Paused' : phase === 'failed' ? 'Upload stopped' : 'Uploading…'}</h2>
          <p className="mt-0.5 text-[13px] text-muted">
            {[folders > 0 && plural(folders, 'folder'), plural(files.length, 'file'), formatBytes(totalBytes), rejected > 0 && `${rejected.toLocaleString()} not taken`].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {phase === 'ready' && <Button variant="ghost" onClick={onClear}>Clear</Button>}
          {phase === 'ready' && <Button variant="primary" onClick={onStart} disabled={tooBig || left === 0}><Upload />Upload</Button>}
          {phase === 'sending' && <Button onClick={onPause}><Pause />Pause</Button>}
          {(phase === 'paused' || (phase === 'failed' && left > 0)) && <Button variant="primary" onClick={onStart}><Play />{phase === 'paused' ? 'Resume' : 'Try again'}</Button>}
          {phase === 'failed' && left === 0 && <Button variant="primary" onClick={onClear}>Choose other files</Button>}
          {phase !== 'ready' && !(phase === 'failed' && left === 0) && <Button variant="ghost" onClick={onCancel}><X />Cancel</Button>}
        </div>
      </div>

      {tooBig && phase === 'ready' && (
        <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-3.5 py-2.5 text-sm font-medium text-danger">
          That is more than one upload may hold ({formatBytes(options.maxBytes)}). Upload fewer albums at a time.
        </p>
      )}
      {upload.error && <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-3.5 py-2.5 text-sm font-medium text-danger">{upload.error}</p>}

      {sending && (
        <div className="mt-4 flex flex-col gap-1.5">
          <ProgressBar value={totalBytes ? sentBytes / totalBytes : null} label="Upload progress" />
          <p className="flex justify-between gap-3 text-xs font-medium text-muted">
            <span className="tabular">{formatBytes(sentBytes)} of {formatBytes(totalBytes)}</span>
            <span className="tabular">{left ? `${plural(left, 'file')} to go` : 'Finishing'}</span>
          </p>
        </div>
      )}

      <FileList files={files} />
      {phase === 'ready' && <p className="mt-3 text-xs text-quiet">Drop more files here to add them.</p>}
    </div>
  )
}

const rowHeight = 44

/** Every chosen file, rendered only near the visible part of its box so thousands stay quick. */
function FileList({ files, className = 'mt-4' }: { files: readonly UploadFileState[]; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  // oxlint-disable-next-line react/incompatible-library -- the virtualizer re-renders on scroll by design
  const virtualizer = useVirtualizer({ count: files.length, getScrollElement: () => box.current, estimateSize: () => rowHeight, overscan: 10, initialRect: { width: 800, height: 400 } })
  return (
    <div ref={box} className={cn('-mx-2 max-h-[26rem] overflow-y-auto [scrollbar-width:thin]', className)}>
      <ul aria-label="Files to upload" className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const file = files[item.index]
          return <FileRow key={item.key} file={file} style={{ transform: `translateY(${item.start}px)` }} />
        })}
      </ul>
    </div>
  )
}

function FileRow({ file, style }: { file: UploadFileState; style: CSSProperties }) {
  const Icon = file.path.toLowerCase().endsWith('.zip') ? FileArchive : FileAudio
  const slash = file.path.lastIndexOf('/')
  return (
    <li style={style} className="absolute inset-x-0 top-0 flex h-11 items-center gap-3 rounded-lg px-2 text-sm">
      <Icon aria-hidden className={cn('size-4 shrink-0', file.status === 'rejected' ? 'text-danger' : 'text-quiet')} />
      <span className="min-w-0 flex-1 truncate" title={file.path}>
        {slash > 0 && <span className="text-muted max-sm:hidden">{file.path.slice(0, slash + 1)}</span>}
        <span className={cn('font-medium', file.status === 'rejected' && 'text-muted line-through decoration-quiet')}>{file.path.slice(slash + 1)}</span>
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs tabular text-quiet sm:block">{formatBytes(file.size)}</span>
      <span className="flex w-24 shrink-0 items-center justify-end gap-2 text-xs font-semibold sm:w-36">
        {file.status === 'accepted' && <span className="flex items-center gap-1 text-accent"><Check className="size-3.5" strokeWidth={3} />Sent</span>}
        {file.status === 'rejected' && file.reason && <span className="truncate text-danger">{rejectionLabels[file.reason]}</span>}
        {file.status === 'sending' && (
          <>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-stroke max-sm:hidden"><span className="block h-full rounded-full bg-accent" style={{ width: `${(file.size ? file.sent / file.size : 1) * 100}%` }} /></span>
            <span className="w-9 text-right tabular text-muted">{Math.round((file.size ? file.sent / file.size : 1) * 100)}%</span>
          </>
        )}
        {file.status === 'waiting' && <span className="text-quiet">Waiting</span>}
      </span>
    </li>
  )
}

/** After an upload: the files it could not send, and why. */
export function NotTaken({ files }: { files: readonly UploadFileState[] }) {
  const rejected = files.filter(file => file.status === 'rejected')
  if (!rejected.length) return null
  return (
    <section aria-labelledby="not-taken" className="flex flex-col gap-3">
      <h3 id="not-taken" className="px-1 text-lg font-bold tracking-tight">Not uploaded</h3>
      <div className="rounded-2xl bg-sheet px-4 py-1 ring-1 ring-stroke"><FileList files={rejected} className="my-0" /></div>
    </section>
  )
}
