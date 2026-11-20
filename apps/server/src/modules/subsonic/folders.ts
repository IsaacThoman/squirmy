/** Music folders: one per library root, under the integer id `folderId` derives. */
import { asc } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { libraryRoots } from '../../database/schema.js'
import { folderId } from './ids.js'
import { invalidParameter, notFound, type Params } from './protocol.js'

export async function musicFolders(): Promise<{ id: number; rootId: string; name: string }[]> {
  const roots = await db.select({ id: libraryRoots.id, name: libraryRoots.name }).from(libraryRoots).orderBy(asc(libraryRoots.name), asc(libraryRoots.createdAt))
  return roots.map((root) => ({ id: folderId(root.id), rootId: root.id, name: root.name }))
}

/** The root a `musicFolderId` parameter names; undefined when the parameter is absent. */
export async function rootParam(params: Params): Promise<string | undefined> {
  const raw = params.string('musicFolderId')
  if (raw === undefined || raw === '') return undefined
  if (!/^\d+$/.test(raw)) throw invalidParameter('musicFolderId')
  const folder = (await musicFolders()).find((candidate) => candidate.id === Number(raw))
  if (!folder) throw notFound('Music folder')
  return folder.rootId
}
