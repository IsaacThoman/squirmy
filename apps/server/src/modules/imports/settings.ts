import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import type { UpdateServerSettings } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { libraryRoots } from '../../database/schema.js'
import { badRequest } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'

/** System folders: never an inbox, and neither is anything inside them. */
const systemTrees = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32', '/proc', '/run', '/sbin', '/sys', '/usr', '/System', '/Library', '/Applications', '/private/etc']
/** Folders of other programs, people or disks: never an inbox, and neither is a folder directly in them. */
const sharedParents = ['/var', '/private', '/private/var', '/opt', '/home', '/Users', '/Volumes']
/** Never an inbox themselves; a folder made for it inside them is fine. */
const mountPoints = ['/mnt', '/media', '/srv', '/tmp', '/private/tmp', '/root']

/**
 * Whether an inbox at `folder` would empty folders that are not there for it: the file
 * system root, the home folder (or one around it), a system folder or a folder around
 * one. The inbox moves every top-level item with a music, log or cue file in it, so `/`,
 * `/var` or a home folder would be taken apart. A dedicated folder such as `/inbox`,
 * `/srv/music/inbox` or `/var/lib/squirmy/inbox` is fine.
 */
export function isSystemFolder(folder: string): boolean {
  const target = path.resolve(folder)
  if (path.parse(target).root === target) return true
  const within = (base: string) => target === base || target.startsWith(base + path.sep)
  const around = (base: string) => base === target || base.startsWith(target + path.sep)
  return around(path.resolve(homedir()))
    || systemTrees.some(within)
    || sharedParents.some((base) => around(base) || path.dirname(target) === base)
    || mountPoints.some(around)
}

const overlaps = (a: string, b: string) => {
  const relative = path.relative(a, b)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Resolves an inbox folder to its real path and checks it can be one: an existing folder
 * that is not a system folder ({@link isSystemFolder}), neither inside nor around a library root (moving music out of the inbox would
 * take it out of the library) nor the server's data folder (staging lives there).
 */
export async function checkInboxPath(requested: string): Promise<string> {
  if (!path.isAbsolute(requested)) throw badRequest('Give the inbox as an absolute path', 'relative_path')
  const resolved = await realpath(requested).catch(() => null)
  if (!resolved || !(await stat(resolved)).isDirectory()) throw badRequest('The inbox folder does not exist', 'inbox_not_found')
  if (isSystemFolder(requested) || isSystemFolder(resolved)) {
    throw badRequest('The inbox must be a folder of its own, not the root, a home folder or a system folder', 'inbox_system_folder')
  }
  for (const root of await db.select({ path: libraryRoots.path }).from(libraryRoots)) {
    const rootPath = await realpath(root.path).catch(() => root.path)
    if (overlaps(rootPath, resolved) || overlaps(resolved, rootPath)) {
      throw badRequest(`The inbox may not be inside or contain the library root ${root.path}`, 'inbox_in_library')
    }
  }
  const dataDir = await realpath(getConfig().SQUIRMY_DATA_DIR).catch(() => path.resolve(getConfig().SQUIRMY_DATA_DIR))
  if (overlaps(dataDir, resolved) || overlaps(resolved, dataDir)) throw badRequest('The inbox may not be inside or contain the data folder', 'inbox_in_data_dir')
  return resolved
}

/** The inbox in effect: the `inboxPath` setting, else SQUIRMY_INBOX_PATH, else none. */
export async function configuredInbox(): Promise<string | null> {
  return (await getServerSettings()).inboxPath ?? getConfig().SQUIRMY_INBOX_PATH ?? null
}

/**
 * Checks the import settings of an admin's settings patch and returns it with the inbox
 * resolved to its real path. A chosen import root must be a managed root.
 */
export async function checkImportSettings(patch: UpdateServerSettings): Promise<UpdateServerSettings> {
  const checked = { ...patch }
  if (patch.inboxPath) checked.inboxPath = await checkInboxPath(patch.inboxPath)
  if (patch.inboxPath === '') checked.inboxPath = null
  if (patch.importRootId) {
    const [root] = await db.select({ mode: libraryRoots.mode }).from(libraryRoots).where(eq(libraryRoots.id, patch.importRootId))
    if (root?.mode !== 'managed') throw badRequest('Imports can only go to a managed library root', 'import_root_not_managed')
  }
  return checked
}
