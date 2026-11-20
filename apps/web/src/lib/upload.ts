import { ApiError, type ApiClient } from '@squirmy/client-core'
import type { Import, ImportFileRejection, ImportFileResult, ImportOptions } from '@squirmy/contracts'
import { errorMessage } from '@/api/errors'

/** A file chosen for upload, with its path inside the import (`Album/01 Song.flac`). */
export type PickedFile = { file: File; path: string }

/** Why a file was not taken: the server's reason, or one of its size limits. */
export type UploadRejection = ImportFileRejection | 'file_too_large' | 'import_too_large'

export type UploadFileState = {
  path: string
  size: number
  /** Bytes of it sent so far. */
  sent: number
  status: 'waiting' | 'sending' | 'accepted' | 'rejected'
  reason: UploadRejection | null
}

/**
 * - `ready`: chosen, nothing sent. `sending`, `paused`. `committed`: every file was sent and
 *   the import is processing (`import`). `cancelled`. `failed`: `error` says why; files
 *   not sent yet can be sent again.
 */
export type UploadPhase = 'ready' | 'sending' | 'paused' | 'committed' | 'cancelled' | 'failed'

export type UploadSnapshot = {
  phase: UploadPhase
  files: readonly UploadFileState[]
  /** Bytes of the files that are sent or still to send. */
  totalBytes: number
  sentBytes: number
  import: Import | null
  error: string | null
}

type ImportsApi = Pick<ApiClient['imports'], 'create' | 'addFiles' | 'commit' | 'cancel'>

/** One request carries files up to this size together, so an album of small files is a few requests. */
const BATCH_BYTES = 16 * 1024 ** 2
const BATCH_FILES = 32
/** Progress re-renders the page at most this often. */
const PROGRESS_MS = 120

/** Dot files and macOS resource forks; the server skips them too. */
const isHidden = (path: string) => path.split('/').some(segment => segment.startsWith('.') || segment === '__MACOSX')

/** The files of a file input: a folder picked with `webkitdirectory` keeps its relative paths. */
export function pickedFiles(files: Iterable<File>): PickedFile[] {
  return [...files].map(file => ({ file, path: file.webkitRelativePath || file.name })).filter(picked => !isHidden(picked.path))
}

/**
 * What was dropped, walking dropped folders. The entries must be taken while the drop
 * event runs; the walk happens after. Files are references to the disk, never read here.
 */
export function droppedFiles(transfer: DataTransfer): Promise<PickedFile[]> {
  const entries = [...transfer.items].flatMap(item => {
    const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null
    return entry ? [entry] : []
  })
  if (!entries.length) return Promise.resolve(pickedFiles(transfer.files))
  return (async () => {
    const found: PickedFile[] = []
    for (const entry of entries) await walk(entry, found)
    return found.filter(picked => !isHidden(picked.path))
  })()
}

async function walk(entry: FileSystemEntry, found: PickedFile[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    found.push({ file, path: entry.fullPath.replace(/^\/+/, '') })
    return
  }
  if (!entry.isDirectory || isHidden(entry.name)) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // A directory answers in batches until one comes back empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) return
    for (const child of batch) await walk(child, found)
  }
}

/** What to call an import of these files: the one folder or file dropped, else a count. */
export function uploadLabel(files: readonly PickedFile[]): string {
  const tops = new Set(files.map(picked => picked.path.split('/')[0]))
  const label = tops.size === 1 ? [...tops][0] : `${files.length.toLocaleString()} files`
  return label.slice(0, 200)
}

/**
 * Sends picked files into a new upload import, then commits it. Files go in requests of a
 * few at a time, read from disk by the browser as they are sent. Pausing stops the request
 * in flight; resuming sends what the server did not confirm, and a file that turns out to
 * have arrived before the pause is counted as sent. Files over the server's limits are not
 * sent at all, and a 413 for one file (or for the whole import) is shown on that file.
 */
/** Files in path order, numbers by value, so an album lists and uploads track by track. */
export function byPath(files: PickedFile[]): PickedFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
}

export class Upload {
  private readonly api: ImportsApi
  /** The files chosen, in order. */
  readonly picked: PickedFile[]
  private readonly label: string
  private files: UploadFileState[]
  /** Files of a request that was stopped; the server may have kept them before the stop. */
  private readonly maybeSent = new Set<number>()
  private snapshot: UploadSnapshot
  private controller: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(api: ImportsApi, picked: PickedFile[], options: Pick<ImportOptions, 'maxFileBytes'>) {
    this.api = api
    this.picked = picked
    this.label = uploadLabel(picked)
    this.files = picked.map(({ file, path }) => file.size > options.maxFileBytes
      ? { path, size: file.size, sent: 0, status: 'rejected', reason: 'file_too_large' }
      : { path, size: file.size, sent: 0, status: 'waiting', reason: null })
    this.snapshot = this.build('ready', null, null)
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  /** Starts sending, or carries on after a pause or a failure. */
  async start(): Promise<void> {
    if (this.snapshot.phase === 'sending' || this.snapshot.phase === 'committed' || this.snapshot.phase === 'cancelled') return
    const controller = new AbortController()
    this.controller = controller
    this.set('sending')
    try {
      let created = this.snapshot.import
      if (!created) {
        created = await this.api.create({ label: this.label })
        this.snapshot = { ...this.snapshot, import: created }
        // Cancelled while it was being created: it goes too.
        if (this.snapshot.phase === 'cancelled') return void await this.api.cancel(created.id).catch(() => {})
        this.emit()
      }
      if (controller.signal.aborted) return
      for (let batch = this.nextBatch(); batch.length; batch = this.nextBatch()) {
        if (!await this.send(created.id, batch, controller.signal)) return
      }
      if (!this.files.some(file => file.status === 'accepted')) {
        await this.api.cancel(created.id).catch(() => {})
        return this.set('failed', { error: 'None of these files can be imported.' })
      }
      this.set('committed', { import: await this.api.commit(created.id) })
    } catch (error) {
      if (!controller.signal.aborted) this.set('failed', { error: errorMessage(error) })
    }
  }

  /** Stops the request in flight. `start` carries on later. */
  pause() {
    if (this.snapshot.phase !== 'sending') return
    this.controller?.abort()
    this.set('paused')
  }

  /** Stops sending and throws away what the server received. */
  async cancel() {
    this.controller?.abort()
    const created = this.snapshot.import
    this.set('cancelled')
    if (created) await this.api.cancel(created.id).catch(() => {})
  }

  private nextBatch(): number[] {
    const batch: number[] = []
    let bytes = 0
    for (let index = 0; index < this.files.length; index++) {
      const file = this.files[index]
      if (file.status !== 'waiting') continue
      if (batch.length && (bytes + file.size > BATCH_BYTES || batch.length >= BATCH_FILES)) break
      batch.push(index)
      bytes += file.size
    }
    return batch
  }

  /** Sends one request. False when sending must stop: a pause, a cancel or a failure. */
  private async send(importId: string, batch: number[], signal: AbortSignal): Promise<boolean> {
    for (const index of batch) this.files[index] = { ...this.files[index], status: 'sending', sent: 0 }
    this.emit()
    try {
      const response = await this.api.addFiles(importId, batch.map(index => ({ data: this.picked[index].file, name: this.picked[index].file.name, relativePath: this.picked[index].path })), {
        signal,
        onProgress: ({ loaded }) => this.progress(batch, loaded),
      })
      this.settle(batch, response.files)
      return true
    } catch (error) {
      if (signal.aborted) {
        for (const index of batch) {
          if (this.files[index].status !== 'sending') continue
          this.files[index] = { ...this.files[index], status: 'waiting', sent: 0 }
          this.maybeSent.add(index)
        }
        this.emit()
        return false
      }
      if (error instanceof ApiError && error.status === 413) {
        const kept = (error.details as { files?: ImportFileResult[] } | undefined)?.files ?? []
        this.settle(batch.slice(0, kept.length), kept)
        const refused = batch[kept.length]
        if (refused !== undefined) this.reject(refused, error.code === 'import_too_large' ? 'import_too_large' : 'file_too_large')
        // A full import takes nothing more.
        if (error.code === 'import_too_large') this.files.forEach((file, index) => { if (file.status !== 'accepted' && file.status !== 'rejected') this.reject(index, 'import_too_large') })
        for (const index of batch) if (this.files[index].status === 'sending') this.files[index] = { ...this.files[index], status: 'waiting', sent: 0 }
        this.emit()
        return true
      }
      for (const index of batch) if (this.files[index].status === 'sending') this.files[index] = { ...this.files[index], status: 'waiting', sent: 0 }
      this.set('failed', { error: errorMessage(error) })
      return false
    }
  }

  private settle(batch: number[], results: ImportFileResult[]) {
    batch.forEach((index, position) => {
      const result = results[position]
      if (!result) return
      // Sent again after a pause: the server already had it.
      const arrived = result.status === 'accepted' || (result.reason === 'duplicate_name' && this.maybeSent.has(index))
      this.files[index] = arrived
        ? { ...this.files[index], status: 'accepted', sent: this.files[index].size, reason: null }
        : { ...this.files[index], status: 'rejected', sent: 0, reason: result.reason }
      this.maybeSent.delete(index)
    })
    this.emit()
  }

  private reject(index: number, reason: UploadRejection) {
    this.files[index] = { ...this.files[index], status: 'rejected', sent: 0, reason }
  }

  /** Spreads the bytes sent of a request over its files, in order. */
  private progress(batch: number[], loaded: number) {
    let left = loaded
    for (const index of batch) {
      const file = this.files[index]
      const sent = Math.max(0, Math.min(file.size, left))
      left -= file.size
      if (sent !== file.sent) this.files[index] = { ...file, sent }
    }
    if (this.timer === null) this.timer = setTimeout(() => this.emit(), PROGRESS_MS)
  }

  private set(phase: UploadPhase, change: { import?: Import; error?: string } = {}) {
    this.snapshot = this.build(phase, change.import ?? this.snapshot?.import ?? null, change.error ?? null)
    this.notify()
  }

  private emit() {
    this.snapshot = this.build(this.snapshot.phase, this.snapshot.import, this.snapshot.error)
    this.notify()
  }

  private notify() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    for (const listener of [...this.listeners]) listener()
  }

  private build(phase: UploadPhase, created: Import | null, error: string | null): UploadSnapshot {
    let totalBytes = 0
    let sentBytes = 0
    for (const file of this.files) {
      if (file.status === 'rejected') continue
      totalBytes += file.size
      sentBytes += file.sent
    }
    return { phase, files: [...this.files], totalBytes, sentBytes, import: created, error }
  }
}
