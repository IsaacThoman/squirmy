/**
 * The cold-storage provider: serves audio files the operator already owns from a folder kept
 * outside the server's library (an archive disk, a slow NAS, a bucket mounted as a folder).
 * Coverage is `must_resolve`, since it knows exactly what it has. Files are delivered as
 * they are; nothing is converted or downloaded from anywhere.
 */
import path from 'node:path'
import type { ProviderOffer } from '@squirmy/contracts'
import { createProviderServer, type DeliveryFile, type ProviderServer } from '@squirmy/provider-kit'
import { albumId, ColdIndex, type ColdFile } from './catalog.js'

export { ColdIndex, DURATION_TOLERANCE_MS, type ColdFile } from './catalog.js'

export type ColdStorageOptions = {
  /** The folder of audio files. */
  folder: string
  secret: string
  /** Shown in the server's admin page. */
  name?: string
  maxConcurrent?: number
}

export type ColdStorageProvider = ProviderServer & { index: ColdIndex }

function offerFor(id: string, files: readonly ColdFile[]): ProviderOffer {
  const first = files[0]!
  const lossless = files.every((file) => file.lossless)
  return {
    offerId: id,
    format: first.format,
    lossless,
    bitrate: lossless ? null : first.bitrate,
    sampleRate: first.sampleRate,
    bitDepth: first.bitDepth,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    etaSeconds: Math.max(1, Math.ceil(files.length / 2)),
  }
}

/** The file's own name under its folder's name, so an album keeps its folder in the import. */
const deliveryName = (file: ColdFile) => {
  const parts = file.relPath.split('/')
  return parts.length > 1 ? parts.slice(-2).join('/') : parts[0]!
}

/** Creates the provider. Call `index.scan()` before `listen()` so it knows what it has. */
export function createColdStorage(options: ColdStorageOptions): ColdStorageProvider {
  const index = new ColdIndex(path.resolve(options.folder))
  const server = createProviderServer({
    secret: options.secret,
    get capabilities() {
      const formats = [...new Set(index.all().map((file) => file.format))].sort()
      return { name: options.name ?? 'Cold storage', coverage: 'must_resolve' as const, kinds: ['recording' as const, 'album' as const], formats, maxConcurrent: options.maxConcurrent ?? 2 }
    },
    resolve(item) {
      if (item.kind === 'recording') {
        const file = index.matchRecording(item.recording)
        return file ? [offerFor(`file:${file.id}`, [file])] : []
      }
      const files = index.matchAlbum(item.album)
      const id = files[0] ? albumId(files[0]) : null
      return id ? [offerFor(`album:${id}`, index.albumFiles(id))] : []
    },
    async fetch(offerId) {
      const [kind, id = ''] = offerId.split(':')
      const files = kind === 'file' ? [index.byId(id)].filter((file) => file !== undefined) : kind === 'album' ? index.albumFiles(id) : []
      if (files.length === 0) throw new Error('That file is no longer in cold storage')
      return { files: files.map((file): DeliveryFile => ({ path: file.path, name: deliveryName(file) })) }
    },
  })
  return Object.assign(server, { index })
}
