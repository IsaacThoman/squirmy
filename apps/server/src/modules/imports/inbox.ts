/**
 * The inbox: a folder the server watches for music to import. Each top-level item (a
 * file or a folder) becomes one `inbox` import once it has been stable for a settle
 * period: no file added, removed, grown or touched, and every file readable. That covers
 * copies still in progress (they keep changing), files the server cannot read yet (their
 * permissions are fixed later), and partial downloads (hidden and `.part` names are never
 * looked at). The item is then moved into staging, and the same item name can be dropped
 * in again later as a new import.
 *
 * What the server cannot import (unsupported files inside an item, or a whole import that
 * failed) is put aside in `Not imported/<importId>/` inside the inbox, never deleted. An
 * item over the size limits is left where it is, with a warning.
 *
 * The inbox is polled rather than watched with `fs.watch`: settling needs a fresh look at
 * every item anyway, and polling one folder works on every file system, network mounts
 * included. Only one process watches it, chosen with a Postgres advisory lock.
 */
import { lstat, open, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db, getSql } from '../../database/client.js'
import { imports } from '../../database/schema.js'
import { AppError } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { isSkipped } from '../library/walk.js'
import { errorCode } from '../organize/files.js'
import { checkRelativePath } from './paths.js'
import { commitImport, createImport, failImport, loadImport, SET_ASIDE_FOLDER, type ImportWork } from './service.js'
import { checkInboxPath, configuredInbox } from './settings.js'
import { moveTree } from './staging.js'

export type InboxOptions = {
  /** Time between looks at the inbox. */
  pollMs: number
  /** How long an item must stay unchanged before it is taken. */
  settleMs: number
  /** Replaceable so tests can force a move across file systems. */
  rename?: Parameters<typeof moveTree>[2]
}

const defaults: InboxOptions = { pollMs: 2000, settleMs: 5000 }

type Survey = { signature: string; files: { absolute: string; relPath: string; size: number }[] }

function warn(message: string) {
  if (getConfig().LOG_LEVEL !== 'silent') console.warn(`[imports] ${message}`)
}

/**
 * Looks at one inbox item without following symbolic links. Null when it cannot be read
 * or holds nothing an import takes. The signature changes whenever a file appears,
 * disappears, grows or is touched.
 */
async function survey(inbox: string, name: string): Promise<Survey | null> {
  const files: Survey['files'] = []
  let latest = 0
  const visit = async (relPath: string): Promise<boolean> => {
    const absolute = path.join(inbox, relPath)
    const info = await lstat(absolute).catch(() => null)
    if (!info) return false
    latest = Math.max(latest, info.mtimeMs)
    if (info.isDirectory()) {
      const entries = await readdir(absolute).catch(() => null)
      if (!entries) return false
      for (const entry of entries.sort()) if (!await visit(`${relPath}/${entry}`)) return false
    } else if (info.isFile() && checkRelativePath(relPath).ok) {
      files.push({ absolute, relPath, size: info.size })
    }
    return true
  }
  if (!await visit(name) || files.length === 0) return null
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  return { signature: `${files.length}:${bytes}:${latest}:${files.map((file) => file.relPath).join('\n')}`, files }
}

async function readable(file: string): Promise<boolean> {
  try {
    await (await open(file, 'r')).close()
    return true
  } catch {
    return false
  }
}

/**
 * Finishes taking an inbox item that is already in staging: sets aside what an import
 * does not take (symbolic links and hidden files are dropped), records what is left, and
 * commits the import. A claim interrupted before the item was fully in staging is dropped
 * instead; the item, still in the inbox, is picked up again.
 */
export async function finishInboxClaim(importId: string): Promise<void> {
  const row = await loadImport(importId)
  if (row.status !== 'receiving' || !row.label || !await lstat(path.join(row.stagingPath, row.label)).then(() => true, () => false)) {
    await rm(row.stagingPath, { recursive: true, force: true })
    if (row.status === 'receiving') await failImport(row.id, 'Interrupted while being taken from the inbox; it is picked up again')
    return
  }
  const work = (row.work ?? {}) as ImportWork
  let files = 0
  let bytes = 0
  let rejected = 0
  const sort = async (relPath: string) => {
    const absolute = path.join(row.stagingPath, relPath)
    const info = await lstat(absolute)
    if (info.isDirectory()) {
      for (const entry of await readdir(absolute)) await sort(`${relPath}/${entry}`)
      return
    }
    const checked = info.isFile() ? checkRelativePath(relPath) : null
    if (checked?.ok) {
      files += 1
      bytes += info.size
    } else if (checked && checked.reason !== 'hidden' && work.inboxPath) {
      rejected += 1
      await moveTree(absolute, path.join(work.inboxPath, SET_ASIDE_FOLDER, row.id, relPath))
    } else {
      await rm(absolute, { force: true })
    }
  }
  await sort(row.label)
  await db.update(imports).set({ receivedFiles: files, receivedBytes: bytes, work: { ...work, rejectedOnReceipt: rejected }, updatedAt: new Date() })
    .where(eq(imports.id, row.id))
  if (files === 0) await failImport(row.id, 'Nothing in it could be imported')
  else await commitImport(row.id)
}

class InboxWatcher {
  private readonly seen = new Map<string, { signature: string; since: number }>()
  private readonly warned = new Set<string>()
  private connection: Awaited<ReturnType<ReturnType<typeof getSql>['reserve']>> | undefined
  private locked = false
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly options: InboxOptions) {}

  start() {
    const loop = () => {
      this.running = this.tick().catch((error: unknown) => warn(`Could not check the inbox: ${(error as Error).message}`)).finally(() => {
        if (!this.stopped) this.timer = setTimeout(loop, this.options.pollMs).unref()
      })
    }
    loop()
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    await this.running
    if (this.connection) {
      if (this.locked) await this.connection`select pg_advisory_unlock(hashtext('squirmy.inbox'))`.catch(() => {})
      this.connection.release()
    }
  }

  private warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return
    this.warned.add(key)
    warn(message)
  }

  /** Takes the inbox lock, and on first taking it finishes claims a crash interrupted. */
  private async lock(): Promise<boolean> {
    if (this.locked) return true
    this.connection ??= await getSql().reserve()
    const [row] = await this.connection<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext('squirmy.inbox')) as locked`
    this.locked = Boolean(row?.locked)
    if (this.locked) {
      const interrupted = await db.select({ id: imports.id }).from(imports).where(and(eq(imports.kind, 'inbox'), eq(imports.status, 'receiving')))
      for (const { id } of interrupted) {
        await finishInboxClaim(id).catch((error: unknown) => warn(`Could not finish the inbox import ${id}: ${(error as Error).message}`))
      }
    }
    return this.locked
  }

  async tick() {
    const configured = await configuredInbox()
    if (!configured || this.stopped) return
    let inbox: string
    try {
      inbox = await checkInboxPath(configured)
    } catch (error) {
      this.warnOnce(`inbox:${configured}`, `Not watching the inbox ${configured}: ${(error as Error).message}`)
      return
    }
    if (!await this.lock()) return
    const names = (await readdir(inbox)).filter((name) => !isSkipped(name) && name !== SET_ASIDE_FOLDER)
    for (const name of this.seen.keys()) if (!names.includes(name)) this.seen.delete(name)

    const { importMaxBytes, importMaxFileBytes } = await getServerSettings()
    for (const name of names) {
      if (this.stopped) return
      const found = await survey(inbox, name)
      const previous = this.seen.get(name)
      if (!found) {
        this.seen.delete(name)
        continue
      }
      if (previous?.signature !== found.signature) {
        this.seen.set(name, { signature: found.signature, since: Date.now() })
        continue
      }
      if (Date.now() - previous.since < this.options.settleMs) continue
      if (found.files.some((file) => file.size > importMaxFileBytes) || found.files.reduce((sum, file) => sum + file.size, 0) > importMaxBytes) {
        this.warnOnce(`size:${name}:${found.signature}`, `Not importing "${name}" from the inbox: it is over the import size limits`)
        continue
      }
      if (!(await Promise.all(found.files.map((file) => readable(file.absolute)))).every(Boolean)) continue
      await this.claim(inbox, name)
      this.seen.delete(name)
    }
  }

  private async claim(inbox: string, name: string) {
    let created
    try {
      created = await createImport({ kind: 'inbox', userId: null, label: name })
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      this.warnOnce(`create:${error.code}`, `Not importing from the inbox: ${error.message}`)
      return
    }
    const work: ImportWork = { inboxPath: inbox }
    const [row] = await db.update(imports).set({ work }).where(eq(imports.id, created.id)).returning()
    try {
      await moveTree(path.join(inbox, name), path.join(row!.stagingPath, name), this.options.rename)
    } catch (error) {
      // Gone or locked since it was surveyed: drop this import and look again later.
      if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(errorCode(error) ?? '')) throw error
    }
    await finishInboxClaim(created.id)
  }
}

let watcher: InboxWatcher | undefined

/** Starts watching the inbox in this process. The folder is read from the settings on every look. */
export function startInbox(overrides: Partial<InboxOptions> = {}) {
  watcher = new InboxWatcher({ ...defaults, ...overrides })
  watcher.start()
}

export async function stopInbox() {
  await watcher?.stop()
  watcher = undefined
}
