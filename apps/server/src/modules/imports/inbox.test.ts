import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { imports } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { updateServerSettings } from '../../lib/settings.js'
import { makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { insertRoot } from '../library/roots.js'
import { startInbox, stopInbox } from './inbox.js'
import { SET_ASIDE_FOLDER } from './service.js'
import { checkImportSettings, checkInboxPath, isSystemFolder } from './settings.js'

const tree = async (dir: string) => (await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []))
  .filter((entry) => !entry.isDirectory()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort()

async function waitFor<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error('Timed out waiting')
    await sleep(25)
  }
}

describe('inbox', () => {
  useTestDatabase()
  let inbox = ''
  let library = ''
  let tone: Buffer
  const options = { pollMs: 50, settleMs: 400 }

  const inboxImports = () => db.select().from(imports).where(eq(imports.kind, 'inbox')).orderBy(imports.id)
  const importOf = (label: string) => waitFor(async () => (await inboxImports()).find((row) => row.label === label && row.status !== 'receiving'))

  beforeAll(async () => {
    await startJobs({ work: false })
    // In a folder of its own, so the folder around it is never the platform's temp folder
    // (/tmp on Linux), which is refused as a system folder before any overlap is checked.
    library = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-inbox-root-'))), 'library')
    await mkdir(library)
    const root = await insertRoot({ name: 'Library', path: library, mode: 'managed', watch: false })
    inbox = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-inbox-')))
    await updateServerSettings({ importRootId: root.id, inboxPath: inbox })
    tone = await readFile(await makeTone(await mkdtemp(path.join(tmpdir(), 'squirmy-inbox-tone-')), { path: 'tone.flac', durationSec: 1 }))
    startInbox(options)
  })

  afterAll(async () => {
    await stopInbox()
    await stopJobs()
  })

  it('refuses an inbox inside or around a library root or the data folder', async () => {
    await mkdir(path.join(library, 'inbox'), { recursive: true })
    await expect(checkInboxPath(path.join(library, 'inbox'))).rejects.toMatchObject({ code: 'inbox_in_library' })
    await expect(checkInboxPath(path.dirname(library))).rejects.toMatchObject({ code: 'inbox_in_library' })
    await expect(checkInboxPath(library)).rejects.toMatchObject({ code: 'inbox_in_library' })
    await expect(checkInboxPath(getConfig().SQUIRMY_DATA_DIR)).rejects.toMatchObject({ code: 'inbox_in_data_dir' })
    await expect(checkInboxPath('relative/inbox')).rejects.toMatchObject({ code: 'relative_path' })
    await expect(checkInboxPath(path.join(inbox, 'missing'))).rejects.toMatchObject({ code: 'inbox_not_found' })
    expect(await checkImportSettings({ inboxPath: `${inbox}/` })).toEqual({ inboxPath: inbox })
    // A folder in the platform's temp folder is a fine inbox.
    expect(await checkInboxPath(inbox)).toBe(inbox)
  })

  it('refuses the file system root, the home folder and system folders', async () => {
    for (const folder of ['/', homedir(), path.dirname(homedir()), '/etc', '/usr', '/usr/lib', '/var', '/var/log', '/dev', '/tmp/..']) {
      await expect(checkInboxPath(folder), folder).rejects.toMatchObject({ code: 'inbox_system_folder' })
    }
    for (const folder of ['/etc/squirmy', '/proc/1', '/var/lib', '/home', '/home/alice', '/Users/alice', '/opt', '/opt/app', '/System/Volumes', '/private/var/db', '/Volumes/Music', '/tmp', '/private/tmp']) {
      expect(isSystemFolder(folder), folder).toBe(true)
    }
    for (const folder of ['/inbox', '/srv/inbox', '/srv/music/inbox', '/var/lib/squirmy/inbox', '/mnt/inbox', '/Volumes/Music/Inbox', path.join(homedir(), 'Inbox'), '/private/var/folders/x/y/T/squirmy-inbox', '/tmp/squirmy-inbox', '/tmp/a/b', '/private/tmp/inbox']) {
      expect(isSystemFolder(folder), folder).toBe(false)
    }
  })

  it('takes a dropped folder once it settles, setting aside what it cannot import', async () => {
    await mkdir(path.join(inbox, 'Drop/CD1'), { recursive: true })
    await writeFile(path.join(inbox, 'Drop/CD1/01 One.flac'), tone)
    await writeFile(path.join(inbox, 'Drop/cover.jpg'), 'jpeg')
    await writeFile(path.join(inbox, 'Drop/notes.txt'), 'keep me')
    await writeFile(path.join(inbox, 'Drop/.DS_Store'), 'mac')
    await symlink('/etc/hosts', path.join(inbox, 'Drop/CD1/02 Link.flac'))
    // Hidden and partial names are never looked at.
    await writeFile(path.join(inbox, '.hidden.flac'), tone)
    await writeFile(path.join(inbox, 'download.flac.part'), tone)

    const row = await importOf('Drop')
    expect(row).toMatchObject({ status: 'processing', step: 'extracting', source: 'inbox', receivedFiles: 2, receivedBytes: tone.length + 4 })
    expect(await tree(row.stagingPath)).toEqual(['Drop/CD1/01 One.flac', 'Drop/cover.jpg'])
    expect(await tree(inbox)).toEqual(['.hidden.flac', `${SET_ASIDE_FOLDER}/${row.id}/Drop/notes.txt`, 'download.flac.part'])
    expect(await readFile(path.join(inbox, SET_ASIDE_FOLDER, row.id, 'Drop/notes.txt'), 'utf8')).toBe('keep me')
  })

  it('waits for a slow copy to finish', async () => {
    const file = path.join(inbox, 'Slow.flac')
    await writeFile(file, tone.subarray(0, 1000))
    for (let offset = 1000; offset < tone.length; offset += 1000) {
      await sleep(150)
      expect((await inboxImports()).some((row) => row.label === 'Slow.flac')).toBe(false)
      await appendFile(file, tone.subarray(offset, offset + 1000))
    }
    const row = await importOf('Slow.flac')
    expect(await readFile(path.join(row.stagingPath, 'Slow.flac'))).toEqual(tone)
  })

  it('waits for files it cannot read yet', async () => {
    if (process.getuid?.() === 0) return
    await mkdir(path.join(inbox, 'Locked'))
    await writeFile(path.join(inbox, 'Locked/01.flac'), tone)
    await chmod(path.join(inbox, 'Locked/01.flac'), 0o000)
    await sleep(options.settleMs * 3)
    expect((await inboxImports()).some((row) => row.label === 'Locked')).toBe(false)
    await chmod(path.join(inbox, 'Locked/01.flac'), 0o644)
    expect((await importOf('Locked')).receivedFiles).toBe(1)
  })

  it('takes an item again when one with the same name reappears', async () => {
    await writeFile(path.join(inbox, 'Again.flac'), tone)
    const first = await importOf('Again.flac')
    await writeFile(path.join(inbox, 'Again.flac'), tone)
    const second = await waitFor(async () => (await inboxImports()).find((row) => row.label === 'Again.flac' && row.id !== first.id && row.status !== 'receiving'))
    expect(second.receivedFiles).toBe(1)
  })

  it('leaves items over the size limits where they are', async () => {
    await updateServerSettings({ importMaxFileBytes: tone.length - 1 })
    await writeFile(path.join(inbox, 'Huge.flac'), tone)
    await sleep(options.settleMs * 3)
    expect((await inboxImports()).some((row) => row.label === 'Huge.flac')).toBe(false)
    expect(await readFile(path.join(inbox, 'Huge.flac'))).toEqual(tone)
    await updateServerSettings({ importMaxFileBytes: 4 * 1024 ** 3 })
    await importOf('Huge.flac')
  })

  it('copies items when the inbox is on another file system', async () => {
    await stopInbox()
    let refused = 0
    startInbox({
      ...options,
      rename: (async (from: string, to: string) => {
        if (from.startsWith(inbox)) {
          refused += 1
          throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
        }
        return rename(from, to)
      }) as typeof rename,
    })
    await mkdir(path.join(inbox, 'Far Away'))
    await writeFile(path.join(inbox, 'Far Away/01.flac'), tone)
    await symlink('/etc/hosts', path.join(inbox, 'Far Away/02.flac'))
    const row = await importOf('Far Away')
    expect(refused).toBe(1)
    expect(await tree(row.stagingPath)).toEqual(['Far Away/01.flac'])
    expect((await readdir(inbox)).includes('Far Away')).toBe(false)
    await stopInbox()
    startInbox(options)
  })
})
