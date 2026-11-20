import { CreateImportRequest, Id, ImportListQuery, type Import, type ImportFileResult, type ImportFilesResponse, type ImportList } from '@squirmy/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireUser, type AuthUser } from '../../lib/auth.js'
import { AppError, badRequest, conflict, forbidden } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { addImportFile, canImport, commitImport, createImport, failImport, getImport, importFor, listImports } from './service.js'

const IdParams = z.object({ id: Id })
/** Parts per upload request, counting the `relativePath` fields. */
const maxParts = 20_000

function requireUploader(request: FastifyRequest): AuthUser {
  const user = requireUser(request)
  if (!canImport(user)) throw forbidden('Uploading is not enabled for your account', 'upload_not_allowed')
  return user
}

/** Routes of the imports module: uploads by admins and members allowed to upload. */
export async function importsRoutes(app: FastifyInstance) {
  app.post('/imports', async (request, reply): Promise<Import> => {
    const user = requireUploader(request)
    const body = CreateImportRequest.parse(request.body ?? {})
    reply.code(201)
    return createImport({ kind: 'upload', userId: user.id, label: body.label })
  })

  app.get('/imports', async (request): Promise<ImportList> => listImports(requireUploader(request), ImportListQuery.parse(request.query)))

  app.get('/imports/:id', async (request): Promise<Import> => {
    const user = requireUploader(request)
    const row = await importFor(user, IdParams.parse(request.params).id)
    return getImport(row.id)
  })

  app.post('/imports/:id/files', async (request): Promise<ImportFilesResponse> => {
    const user = requireUploader(request)
    const row = await importFor(user, IdParams.parse(request.params).id)
    if (row.kind !== 'upload') throw conflict('Files can only be uploaded to an upload import', 'import_not_upload')
    if (row.status !== 'receiving') throw conflict('The import is no longer receiving files', 'import_not_receiving')
    if (!request.isMultipart()) throw badRequest('Send the files as multipart/form-data', 'not_multipart')
    const { importMaxFileBytes } = await getServerSettings()
    const files: ImportFileResult[] = []
    let relativePath: string | undefined
    try {
      // Our own byte count enforces the limit; the parser's is one byte looser so ours speaks first.
      for await (const part of request.parts({ limits: { fileSize: importMaxFileBytes + 1, parts: maxParts } })) {
        if (part.type === 'field') {
          if (part.fieldname === 'relativePath') relativePath = String(part.value)
          continue
        }
        files.push(await addImportFile(row.id, { filename: part.filename, relativePath, stream: part.file }))
        relativePath = undefined
      }
    } catch (error) {
      // The files before the one that failed were kept; say which.
      if (error instanceof AppError) throw new AppError(error.status, error.code, error.message, { ...(error.details as object | undefined), files })
      throw error
    }
    return { import: await getImport(row.id), files }
  })

  app.post('/imports/:id/commit', async (request, reply): Promise<Import> => {
    const user = requireUploader(request)
    const row = await importFor(user, IdParams.parse(request.params).id)
    reply.code(202)
    return commitImport(row.id)
  })

  app.delete('/imports/:id', async (request): Promise<Import> => {
    const user = requireUploader(request)
    const row = await importFor(user, IdParams.parse(request.params).id)
    return failImport(row.id, 'Cancelled')
  })
}
