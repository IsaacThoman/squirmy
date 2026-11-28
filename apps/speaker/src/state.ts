import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

/**
 * What the speaker keeps between runs: its device id (generated once, so the server and the
 * account's devices know it as one speaker) and its sign-in. The token is a session like an
 * app's, so the file is readable by its owner only.
 */
const SavedState = z.object({
  deviceId: z.string().min(8).max(80),
  server: z.string().optional(),
  token: z.string().optional(),
  /** The account it is signed in to, for the log and the status page. */
  account: z.string().optional(),
})
export type SpeakerState = z.infer<typeof SavedState>

const file = (dir: string) => path.join(dir, 'speaker.json')

export async function loadState(dir: string): Promise<SpeakerState> {
  try {
    return SavedState.parse(JSON.parse(await readFile(file(dir), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${file(dir)}`, { cause: error })
    const fresh = { deviceId: `speaker-${randomUUID()}` }
    await saveState(dir, fresh)
    return fresh
  }
}

export async function saveState(dir: string, state: SpeakerState): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const partial = `${file(dir)}.${process.pid}.tmp`
  await writeFile(partial, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(partial, file(dir))
}
