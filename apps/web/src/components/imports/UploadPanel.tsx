import type { ImportOptions, ImportUnavailable } from '@squirmy/contracts'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, FileArchive, FileAudio, FolderUp, Pause, Play, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { Note } from '@/components/admin/note'
import { InlineNote } from '@/components/admin/Panel'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { EmptyState, ProgressBar, Skeleton, Spinner } from '@/components/ui/feedback'
import { formatBytes, plural } from '@/lib/format'
import { rejectionLabels } from '@/lib/imports'
import type { UploadFileState, UploadSnapshot } from '@/lib/upload'
import { cn } from '@/lib/utils'

const linkClass = 'rounded-sm font-medium text-foreground underline underline-offset-4 outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring'

const unavailableText: Record<ImportUnavailable, { admin: ReactNode; member: string }> = {
  no_managed_root: {
    admin: <>Uploads are filed into a managed music folder, and this server has none yet. Add one, or let Squirmy manage an existing folder, in <Link to="/admin/library" className={linkClass}>Library settings</Link>.</>,
    member: 'Uploads are filed into a managed music folder, and this server has none yet. Ask an admin to add one.',
  },
  import_root_not_set: {
    admin: <>This server has several managed folders. Choose the one uploads go to in <Link to="/admin/settings" className={linkClass}>Server settings</Link>.</>,
    member: 'An admin needs to choose which music folder uploads go to.',
  },
  import_root_unavailable: {
    admin: <>The folder chosen for uploads is disabled, gone, or no longer managed. Choose another in <Link to="/admin/settings" className={linkClass}>Server settings</Link>.</>,
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
  /** Takes one chosen file out before anything was sent. */
  onRemove: (path: string) => void
  /** What the last choice or cancel came to, when nothing else on the panel shows it ("Nothing to upload"). */
  note?: Note | null
}

/** Choosing music to upload and sending it, with progress for each file and for all of them. */
export function UploadPanel({ options, isAdmin, upload, reading, onDrop, onPick, onStart, onPause, onCancel, onClear, onRemove, note = null }: UploadPanelProps) {
  if (!options) return <Skeleton className="h-64 rounded-xl" />
  if (options.unavailable) {
    const text = unavailableText[options.unavailable]
    return (
      <div className="rounded-xl border bg-card">
        <EmptyState icon={<FolderUp />} title="Uploads have nowhere to go yet" description={isAdmin ? undefined : text.member} action={isAdmin ? <p className="-mt-4 max-w-md text-sm text-muted-foreground">{text.admin}</p> : undefined} />
      </div>
    )
  }
  if (!upload) return <DropZone options={options} reading={reading} onDrop={onDrop} onPick={onPick} note={note} />
  return <UploadQueue options={options} upload={upload} reading={reading} onStart={onStart} onPause={onPause} onCancel={onCancel} onClear={onClear} onRemove={onRemove} onDrop={onDrop} onPick={onPick} note={note} />
}

/** The browser's file and folder choosers, opened from buttons. A chosen folder keeps its paths. */
function usePickers(onPick: (files: FileList) => void) {
  const files = useRef<HTMLInputElement>(null)
  const folder = useRef<HTMLInputElement>(null)
  const pick = (input: HTMLInputElement) => {
    if (input.files?.length) onPick(input.files)
    input.value = ''
  }
  return {
    chooseFiles: () => files.current?.click(),
    chooseFolder: () => folder.current?.click(),
    inputs: (
      <>
        <input ref={files} type="file" multiple hidden aria-label="Music files" onChange={event => pick(event.currentTarget)} />
        <input ref={folder} type="file" hidden aria-label="Music folder" {...{ webkitdirectory: '' }} onChange={event => pick(event.currentTarget)} />
      </>
    ),
  }
}

function DropZone({ options, reading, onDrop, onPick, note }: { options: ImportOptions; reading: boolean; onDrop: (transfer: DataTransfer) => void; onPick: (files: FileList) => void; note: Note | null }) {
  const [over, setOver] = useState(false)
  const { chooseFiles, chooseFolder, inputs } = usePickers(onPick)
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
      className={cn('flex flex-col items-center rounded-xl border border-dashed px-6 py-12 text-center transition-colors', over ? 'border-primary bg-primary/10' : 'border-input bg-card')}
    >
      <div className={cn('mb-4 flex size-11 items-center justify-center rounded-xl border bg-background shadow-xs transition-colors [&_svg]:size-5', over ? 'border-primary/40 text-primary' : 'text-muted-foreground')}>
        {reading ? <Spinner label="Reading the folder" /> : <Upload />}
      </div>
      <h2 className="text-base font-semibold">{reading ? 'Reading the folder…' : 'Drop music here'}</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Album folders, single files or zip archives. Folders keep their structure, and the server identifies and files the albums.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={chooseFolder} disabled={reading}><FolderUp />Choose a folder</Button>
        <Button variant="outline" onClick={chooseFiles} disabled={reading}><FileAudio />Choose files</Button>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">Up to {formatBytes(options.maxFileBytes)} per file and {formatBytes(options.maxBytes)} per upload.</p>
      <InlineNote note={note} className="mt-3 text-sm" />
      {inputs}
    </div>
  )
}

function Problem({ children }: { children: ReactNode }) {
  return <p role="alert" className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{children}</p>
}

type UploadQueueProps = Omit<UploadPanelProps, 'options' | 'upload' | 'isAdmin' | 'note'> & { options: ImportOptions; upload: UploadSnapshot; note: Note | null }

function UploadQueue({ options, upload, reading, onStart, onPause, onCancel, onClear, onRemove, onDrop, onPick, note }: UploadQueueProps) {
  const { phase, files, totalBytes, sentBytes } = upload
  const { chooseFiles, chooseFolder, inputs } = usePickers(onPick)
  const rejected = files.filter(file => file.status === 'rejected').length
  const left = files.filter(file => file.status === 'waiting' || file.status === 'sending').length
  const tooBig = totalBytes > options.maxBytes
  const folders = new Set(files.map(file => (file.path.includes('/') ? file.path.split('/')[0] : null)).filter(Boolean)).size
  const sending = phase === 'sending' || phase === 'paused' || (phase === 'failed' && sentBytes > 0)
  return (
    <div
      className="overflow-hidden rounded-xl border bg-card"
      onDragOver={event => { if (phase === 'ready' && event.dataTransfer.types.includes('Files')) event.preventDefault() }}
      onDrop={event => {
        if (phase !== 'ready') return
        event.preventDefault()
        onDrop(event.dataTransfer)
      }}
    >
      <div className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{phase === 'ready' ? 'Ready to upload' : phase === 'paused' ? 'Paused' : phase === 'failed' ? 'Upload stopped' : 'Uploading…'}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {[folders > 0 && plural(folders, 'folder'), plural(files.length, 'file'), formatBytes(totalBytes), rejected > 0 && `${rejected.toLocaleString()} ${phase === 'ready' ? 'cannot be uploaded' : 'not taken'}`].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {phase !== 'ready' && !(phase === 'failed' && left === 0) && <Button size="sm" variant="ghost" onClick={onCancel}><X />Cancel</Button>}
            {phase === 'ready' && <Button size="sm" variant="ghost" onClick={onClear}>Clear</Button>}
            {phase === 'ready' && <Button size="sm" variant="primary" onClick={onStart} disabled={tooBig || left === 0}><Upload />Upload</Button>}
            {phase === 'sending' && <Button size="sm" variant="outline" onClick={onPause}><Pause />Pause</Button>}
            {(phase === 'paused' || (phase === 'failed' && left > 0)) && <Button size="sm" variant="primary" onClick={onStart}><Play />{phase === 'paused' ? 'Resume' : 'Try again'}</Button>}
            {phase === 'failed' && left === 0 && <Button size="sm" variant="primary" onClick={onClear}>Choose other files</Button>}
          </div>
        </div>

        {tooBig && phase === 'ready' && <Problem>That is more than one upload may hold ({formatBytes(options.maxBytes)}). Upload fewer albums at a time.</Problem>}
        {upload.error && <Problem>{upload.error}</Problem>}
        <InlineNote note={note} className="mt-3 text-sm" />

        {sending && (
          <div className="mt-4 flex flex-col gap-2">
            <ProgressBar value={totalBytes ? sentBytes / totalBytes : null} label="Upload progress" />
            <p className="flex justify-between gap-3 text-xs text-muted-foreground">
              <span className="tabular">{formatBytes(sentBytes)} of {formatBytes(totalBytes)}</span>
              <span className="tabular">{left ? `${plural(left, 'file')} to go` : 'Finishing'}</span>
            </p>
          </div>
        )}
      </div>

      <FileList files={files} onRemove={phase === 'ready' ? onRemove : undefined} className="border-t" />
      {phase === 'ready' && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t px-2 py-1.5">
          <Button size="sm" variant="ghost" onClick={chooseFiles} disabled={reading}><FileAudio />Add files</Button>
          <Button size="sm" variant="ghost" onClick={chooseFolder} disabled={reading}><FolderUp />Add a folder</Button>
          <p className="px-1 text-xs text-muted-foreground">{reading ? 'Reading the folder…' : 'Or drop more here.'}</p>
          {inputs}
        </div>
      )}
    </div>
  )
}

const rowHeight = 36

/**
 * Every chosen file, rendered only near the visible part of its box so thousands stay quick.
 * With `onRemove`, each has a button that takes it out; focus moves to the next one's.
 */
function FileList({ files, onRemove, className }: { files: readonly UploadFileState[]; onRemove?: (path: string) => void; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const removed = useRef<number | null>(null)
  // oxlint-disable-next-line react/incompatible-library -- the virtualizer re-renders on scroll by design
  const virtualizer = useVirtualizer({ count: files.length, getScrollElement: () => box.current, estimateSize: () => rowHeight, overscan: 10, initialRect: { width: 800, height: 400 } })
  useEffect(() => {
    const index = removed.current
    if (index === null || !files.length) return
    removed.current = null
    box.current?.querySelector<HTMLElement>(`[data-index="${Math.min(index, files.length - 1)}"] button`)?.focus()
  }, [files])
  return (
    <div ref={box} className={cn('max-h-96 overflow-y-auto px-2 py-1 [scrollbar-width:thin]', className)}>
      <ul aria-label="Files to upload" className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map(item => {
          const file = files[item.index]
          const remove = onRemove && (() => {
            removed.current = item.index
            onRemove(file.path)
          })
          return <FileRow key={item.key} index={item.index} file={file} onRemove={remove} style={{ transform: `translateY(${item.start}px)` }} />
        })}
      </ul>
    </div>
  )
}

function FileRow({ file, index, onRemove, style }: { file: UploadFileState; index: number; onRemove?: () => void; style: CSSProperties }) {
  const Icon = file.path.toLowerCase().endsWith('.zip') ? FileArchive : FileAudio
  const slash = file.path.lastIndexOf('/')
  const progress = file.size ? file.sent / file.size : 1
  return (
    <li style={style} data-index={index} className="absolute inset-x-0 top-0 flex h-9 items-center gap-2.5 px-2 text-sm">
      <Icon aria-hidden className={cn('size-4 shrink-0', file.status === 'rejected' ? 'text-destructive' : 'text-muted-foreground')} />
      <span className="min-w-0 flex-1 truncate" title={file.path}>
        {slash > 0 && <span className="text-muted-foreground max-sm:hidden">{file.path.slice(0, slash + 1)}</span>}
        <span className={cn(file.status === 'rejected' && 'text-muted-foreground line-through decoration-muted-foreground/60')}>{file.path.slice(slash + 1)}</span>
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs tabular text-muted-foreground sm:block">{formatBytes(file.size)}</span>
      <span className="flex w-24 shrink-0 items-center justify-end gap-2 text-xs sm:w-36">
        {file.status === 'accepted' && <span className="flex items-center gap-1 text-muted-foreground"><Check className="size-3.5 text-primary" strokeWidth={2.5} />Sent</span>}
        {file.status === 'rejected' && file.reason && <span className="truncate text-destructive">{rejectionLabels[file.reason]}</span>}
        {file.status === 'sending' && (
          <>
            <span className="h-1 w-16 overflow-hidden rounded-full bg-muted max-sm:hidden"><span className="block h-full rounded-full bg-primary" style={{ width: `${progress * 100}%` }} /></span>
            <span className="w-9 text-right tabular text-foreground">{Math.round(progress * 100)}%</span>
          </>
        )}
        {file.status === 'waiting' && !onRemove && <span className="text-muted-foreground">Waiting</span>}
      </span>
      {onRemove && (
        <IconButton label={`Remove ${file.path.slice(slash + 1)}`} size="xs" onClick={onRemove} className="-mr-1 pointer-coarse:after:absolute pointer-coarse:after:-inset-2.5"><X /></IconButton>
      )}
    </li>
  )
}

/** After an upload: the files it could not send, and why. */
export function NotTaken({ files }: { files: readonly UploadFileState[] }) {
  const rejected = files.filter(file => file.status === 'rejected')
  if (!rejected.length) return null
  return (
    <section aria-labelledby="not-taken">
      <h3 id="not-taken" className="text-sm font-semibold">Not uploaded</h3>
      <div className="mt-3 overflow-hidden rounded-xl border bg-card"><FileList files={rejected} /></div>
    </section>
  )
}
