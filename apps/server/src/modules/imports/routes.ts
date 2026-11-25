import {
  AdminUploadAlbumQuery, AdminUploadsQuery, CreateImportRequest, Id, ImportListQuery, PageQuery,
  type DeleteUploadsResponse, type Import, type ImportAlbumList, type ImportFileResult, type ImportFilesResponse, type ImportList,
  type ImportOptions, type UploadAlbumPage, type UploadFileList,
} from '@squirmy/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAdmin, requireUser, type AuthUser } from '../../lib/auth.js'
import { AppError, badRequest, conflict, forbidden } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { requireRoomFor } from './space.js'
import { stagingRoot } from './staging.js'
import {
  addImportFile, canImport, commitImport, createImport, failImport, getImport, importAlbums, importFor, importOptions, listImports,
} from './service.js'
import { deleteUploadAlbum, deleteUploadFile, listUploadFiles, listUploads } from './uploads.js'

const IdParams = z.object({ id: Id })
const AlbumParams = z.object({ albumId: Id })
const FileParams = z.object({ fileId: Id })
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

  app.get('/imports/options', async (request): Promise<ImportOptions> => {
    requireUploader(request)
    return importOptions()
  })

  app.get('/imports/:id', async (request): Promise<Import> => {
    const user = requireUploader(request)
    const row = await importFor(user, IdParams.parse(request.params).id)
    return getImport(row.id)
  })

  app.get('/imports/:id/albums', async (request): Promise<ImportAlbumList> => {
    const user = requireUploader(request)
    const row = await importFor(user, IdParams.parse(request.params).id)
    return { items: await importAlbums(row.id), nextCursor: null }
  })

  app.post('/imports/:id/files', async (request): Promise<ImportFilesResponse> => {
    const user = requireUploader(request)
    const row = await importFor(user, IdParams.parse(request.params).id)
    if (row.kind !== 'upload') throw conflict('Files can only be uploaded to an upload import', 'import_not_upload')
    if (row.status !== 'receiving') throw conflict('The import is no longer receiving files', 'import_not_receiving')
    if (!request.isMultipart()) throw badRequest('Send the files as multipart/form-data', 'not_multipart')
    // The whole request when its length is known; addImportFile keeps checking either way.
    await requireRoomFor(stagingRoot(), Number(request.headers['content-length']) || 0)
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

  // Your own uploads, for anyone signed in: someone whose uploading was switched off can
  // still remove what they brought.
  app.get('/me/uploads', async (request): Promise<UploadAlbumPage> =>
    listUploads({ own: requireUser(request).id }, PageQuery.parse(request.query)))
  app.get('/me/uploads/albums/:albumId', async (request): Promise<UploadFileList> => {
    const user = requireUser(request)
    const { albumId } = AlbumParams.parse(request.params)
    return { items: await listUploadFiles(user.id, { own: user.id }, albumId), nextCursor: null }
  })
  app.delete('/me/uploads/albums/:albumId', async (request): Promise<DeleteUploadsResponse> =>
    deleteUploadAlbum({ own: requireUser(request).id }, AlbumParams.parse(request.params).albumId))
  app.delete('/me/uploads/files/:fileId', async (request): Promise<DeleteUploadsResponse> =>
    deleteUploadFile({ own: requireUser(request).id }, FileParams.parse(request.params).fileId))

  app.get('/admin/uploads', async (request): Promise<UploadAlbumPage> => {
    requireAdmin(request)
    const { uploader, ...page } = AdminUploadsQuery.parse(request.query)
    return listUploads({ uploader }, page)
  })
  app.get('/admin/uploads/albums/:albumId', async (request): Promise<UploadFileList> => {
    const admin = requireAdmin(request)
    const { albumId } = AlbumParams.parse(request.params)
    return { items: await listUploadFiles(admin.id, AdminUploadAlbumQuery.parse(request.query), albumId), nextCursor: null }
  })
  app.delete('/admin/uploads/albums/:albumId', async (request): Promise<DeleteUploadsResponse> => {
    requireAdmin(request)
    return deleteUploadAlbum(AdminUploadAlbumQuery.parse(request.query), AlbumParams.parse(request.params).albumId)
  })
  app.delete('/admin/uploads/files/:fileId', async (request): Promise<DeleteUploadsResponse> => {
    requireAdmin(request)
    return deleteUploadFile({}, FileParams.parse(request.params).fileId)
  })
}
