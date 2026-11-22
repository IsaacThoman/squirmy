/**
 * Watches enabled roots that have `watch` on and scans just the paths that changed.
 *
 * - macOS and Windows: one recursive `fs.watch` per root, backed by FSEvents and
 *   ReadDirectoryChangesW. One handle covers any number of folders.
 * - Linux: one non-recursive `fs.watch` (an inotify watch) per folder, added as folders
 *   appear. Node's own recursive mode on Linux walks the tree synchronously and adds a
 *   watch per file, which blocks the event loop and exhausts inotify on a large library.
 *   Docker bind mounts of a Linux host folder deliver inotify events normally.
 *
 * Watching cannot work everywhere, and then it quietly does nothing; the nightly scan
 * catches up. NFS, SMB/CIFS, 9p and Ceph mounts are not watched at all (inotify does not
 * see changes made by other machines). Running out of inotify watches
 * (`fs.inotify.max_user_watches`) stops watching that root with one warning.
 */
import { watch, type FSWatcher } from 'node:fs'
import { lstat, readdir, realpath, statfs } from 'node:fs/promises'
import path from 'node:path'
import { db } from '../../database/client.js'
import { libraryRoots } from '../../database/schema.js'
import { enqueue } from '../../jobs/index.js'
import { warn } from './progress.js'
import { isAudioFile, isSkipped, isSkippedPath } from './walk.js'

export type WatchOptions = {
  /** Quiet time after the last change before scanning. */
  debounceMs: number
  /** Longest a burst of changes can delay a scan. */
  maxWaitMs: number
  /** Retry delay when a scan of the root is already queued. */
  retryMs: number
}

const defaults: WatchOptions = { debounceMs: 2000, maxWaitMs: 15_000, retryMs: 5000 }
const perFolder = process.platform !== 'darwin' && process.platform !== 'win32'
// statfs f_type magic numbers of network file systems (Linux).
const networkFileSystems = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42, 0x01021997, 0x00c36400, 0x5346414f])
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name)

class RootWatcher {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly pending = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private firstChangeAt: number | undefined
  private closed = false

  constructor(readonly rootId: string, readonly root: string, private readonly options: WatchOptions) {}

  async start() {
    if (perFolder) {
      const type = await statfs(this.root).then((info) => info.type, () => undefined)
      if (type !== undefined && networkFileSystems.has(type)) {
        warn(`Not watching ${this.root}: it is a network mount. Changes are picked up by the nightly scan.`)
        return
      }
      await this.watchTree('')
    } else {
      this.watchFolder('', true)
    }
  }

  close() {
    this.closed = true
    clearTimeout(this.timer)
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
  }

  private watchFolder(relDir: string, recursive: boolean) {
    if (this.closed || this.watchers.has(relDir)) return
    try {
      const watcher = watch(path.join(this.root, relDir), { recursive, persistent: false }, (_event, name) => {
        this.changed(name ? join(relDir, name.toString().split(path.sep).join('/')) : relDir)
      })
      watcher.on('error', (error) => this.failed(relDir, error))
      this.watchers.set(relDir, watcher)
    } catch (error) {
      this.failed(relDir, error)
    }
  }

  private async watchTree(relDir: string) {
    this.watchFolder(relDir, false)
    const entries = await readdir(path.join(this.root, relDir), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (this.closed) return
      if (entry.isDirectory() && !isSkipped(entry.name)) await this.watchTree(join(relDir, entry.name))
    }
  }

  private failed(relDir: string, error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOSPC' || code === 'EMFILE') {
      if (!this.closed) warn(`Stopped watching ${this.root}: the system allows too few file watches (raise fs.inotify.max_user_watches). Changes are picked up by the nightly scan.`)
      this.close()
      return
    }
    this.unwatch(relDir)
  }

  private unwatch(relDir: string) {
    this.watchers.get(relDir)?.close()
    this.watchers.delete(relDir)
  }

  private changed(relPath: string) {
    if (this.closed || (relPath && isSkippedPath(relPath))) return
    this.pending.add(relPath)
    const now = Date.now()
    this.firstChangeAt ??= now
    clearTimeout(this.timer)
    const delay = Math.max(0, Math.min(this.options.debounceMs, this.firstChangeAt + this.options.maxWaitMs - now))
    this.timer = setTimeout(() => void this.flush().catch((error: unknown) => warn(`Could not queue a scan of ${this.root}`, error)), delay)
  }

  /** Turns changed paths into scan scopes: new folders, audio files, and anything deleted. */
  private async flush() {
    const changed = [...this.pending]
    this.pending.clear()
    this.firstChangeAt = undefined
    const scopes: string[] = []
    for (const relPath of changed) {
      // Not following links: a linked folder is never watched, and a link is a scope the
      // walk decides on like any other entry.
      const info = await lstat(path.join(this.root, relPath)).catch(() => null)
      if (info?.isDirectory()) {
        if (perFolder) await this.watchTree(relPath)
        scopes.push(relPath)
      } else if (info?.isFile()) {
        if (isAudioFile(relPath)) scopes.push(relPath)
      } else {
        for (const watched of [...this.watchers.keys()]) {
          if (watched === relPath || watched.startsWith(`${relPath}/`)) this.unwatch(watched)
        }
        scopes.push(relPath)
      }
    }
    if (this.closed || scopes.length === 0) return
    const queued = await enqueue('library.scan', { rootId: this.rootId, paths: scopes }, { singletonKey: this.rootId })
    if (queued === null) {
      // A scan of this root is queued or running; try again once it has had a chance to finish.
      for (const scope of scopes) this.pending.add(scope)
      this.firstChangeAt = Date.now()
      this.timer = setTimeout(() => void this.flush().catch((error: unknown) => warn(`Could not queue a scan of ${this.root}`, error)), this.options.retryMs)
    }
  }
}

const watchers = new Map<string, { path: string; watcher: RootWatcher }>()
let options: WatchOptions | undefined
let refreshTimer: NodeJS.Timeout | undefined
let refreshing: Promise<void> = Promise.resolve()

/** Starts watching. Roots are re-read every minute, so changes made by an API-only process apply. */
export async function startWatching(overrides: Partial<WatchOptions> = {}) {
  options = { ...defaults, ...overrides }
  await refreshWatchers()
  refreshTimer = setInterval(() => void refreshWatchers().catch((error: unknown) => warn('Could not refresh watchers', error)), 60_000).unref()
}

export async function stopWatching() {
  options = undefined
  clearInterval(refreshTimer)
  await refreshing
  for (const { watcher } of watchers.values()) watcher.close()
  watchers.clear()
}

/** Matches the running watchers to the roots table. A no-op in processes that do not watch. */
export async function refreshWatchers() {
  refreshing = refreshing.then(async () => {
    if (!options) return
    const roots = await db.select({ id: libraryRoots.id, path: libraryRoots.path, enabled: libraryRoots.enabled, watch: libraryRoots.watch }).from(libraryRoots)
    const wanted = new Map(roots.filter((root) => root.enabled && root.watch).map((root) => [root.id, root.path]))
    for (const [id, entry] of watchers) {
      if (wanted.get(id) === entry.path) continue
      entry.watcher.close()
      watchers.delete(id)
    }
    for (const [id, rootPath] of wanted) {
      if (watchers.has(id) || !options) continue
      const real = await realpath(rootPath).catch(() => null)
      if (!real) continue
      const watcher = new RootWatcher(id, real, options)
      watchers.set(id, { path: rootPath, watcher })
      await watcher.start()
    }
  })
  return refreshing
}
