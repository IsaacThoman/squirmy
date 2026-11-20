import { ApiError } from '@squirmy/client-core'
import type { Import, ImportFileResult } from '@squirmy/contracts'
import { describe, expect, it, vi } from 'vitest'
import { pickedFiles, Upload, uploadLabel, type PickedFile } from './upload'

const importRow = { id: '00000000-0000-4000-8000-000000000001', status: 'receiving' } as Import
const file = (path: string, size = 10): PickedFile => ({ file: new File([new Uint8Array(size)], path.split('/').pop()!), path })
const accepted = (path: string, bytes = 10): ImportFileResult => ({ path, status: 'accepted', reason: null, bytes })

function fakeImports(addFiles: (...args: never[]) => Promise<unknown>) {
  return {
    create: vi.fn(async () => importRow),
    addFiles: vi.fn(addFiles),
    commit: vi.fn(async () => ({ ...importRow, status: 'processing' }) as Import),
    cancel: vi.fn(async () => ({ ...importRow, status: 'failed' }) as Import),
  }
}

describe('picking files', () => {
  it('keeps folder paths and leaves hidden files out', () => {
    const inFolder = (name: string, path: string) => Object.assign(new File(['x'], name), { webkitRelativePath: path })
    expect(pickedFiles([inFolder('01.flac', 'Blue Hour/01.flac'), inFolder('.DS_Store', 'Blue Hour/.DS_Store'), new File(['x'], 'one.mp3')]).map(picked => picked.path))
      .toEqual(['Blue Hour/01.flac', 'one.mp3'])
  })

  it('names the import after the one folder or file, else counts', () => {
    expect(uploadLabel([file('Blue Hour/01.flac'), file('Blue Hour/02.flac')])).toBe('Blue Hour')
    expect(uploadLabel([file('Blue Hour.zip')])).toBe('Blue Hour.zip')
    expect(uploadLabel([file('a.flac'), file('b.flac')])).toBe('2 files')
  })
})

describe('Upload', () => {
  it('sends the files with their paths, then commits', async () => {
    const api = fakeImports(async (_id: string, parts: { relativePath: string }[], options: { onProgress: (progress: { loaded: number; total: number }) => void }) => {
      options.onProgress({ loaded: 15, total: 20 })
      return { import: importRow, files: parts.map(part => part.relativePath.endsWith('.txt') ? { path: part.relativePath, status: 'rejected', reason: 'unsupported_type', bytes: 0 } : accepted(part.relativePath)) }
    })
    const upload = new Upload(api as never, [file('Album/01.flac'), file('Album/notes.txt'), file('Album/02.flac', 2000)], { maxFileBytes: 1000 })
    expect(upload.getSnapshot().files.map(state => state.reason)).toEqual([null, null, 'file_too_large'])
    await upload.start()
    const snapshot = upload.getSnapshot()
    expect(api.create).toHaveBeenCalledWith({ label: 'Album' })
    expect(api.addFiles.mock.calls[0]![1]).toEqual([
      expect.objectContaining({ name: '01.flac', relativePath: 'Album/01.flac' }),
      expect.objectContaining({ name: 'notes.txt', relativePath: 'Album/notes.txt' }),
    ])
    expect(snapshot.files.map(state => [state.status, state.reason])).toEqual([['accepted', null], ['rejected', 'unsupported_type'], ['rejected', 'file_too_large']])
    expect(snapshot).toMatchObject({ phase: 'committed', totalBytes: 10, sentBytes: 10 })
    expect(api.commit).toHaveBeenCalledWith(importRow.id)
  })

  it('marks the file the server refused for its size and carries on with the rest', async () => {
    let calls = 0
    const api = fakeImports(async (_id: string, parts: { relativePath: string }[]) => {
      calls += 1
      if (calls === 1) throw new ApiError(413, 'file_too_large', 'Too large', { limit: 10, files: [accepted(parts[0]!.relativePath)] })
      return { import: importRow, files: parts.map(part => accepted(part.relativePath)) }
    })
    const upload = new Upload(api as never, [file('a.flac'), file('big.flac'), file('c.flac')], { maxFileBytes: 1000 })
    await upload.start()
    expect(upload.getSnapshot().files.map(state => [state.path, state.status])).toEqual([['a.flac', 'accepted'], ['big.flac', 'rejected'], ['c.flac', 'accepted']])
    expect(upload.getSnapshot().files[1]!.reason).toBe('file_too_large')
    expect(api.addFiles.mock.calls[1]![1]).toEqual([expect.objectContaining({ relativePath: 'c.flac' })])
  })

  it('pauses mid-request and, on resuming, counts a file the server already had as sent', async () => {
    let release: () => void = () => {}
    let calls = 0
    const api = fakeImports((_id: string, parts: { relativePath: string }[], options: { signal: AbortSignal }) => {
      calls += 1
      if (calls === 1) return new Promise((_resolve, reject) => { release = () => reject(new ApiError(0, 'network_error', 'stopped')); options.signal.addEventListener('abort', () => release()) })
      return Promise.resolve({ import: importRow, files: parts.map(part => ({ path: part.relativePath, status: 'rejected', reason: 'duplicate_name', bytes: 0 })) })
    })
    const upload = new Upload(api as never, [file('a.flac')], { maxFileBytes: 1000 })
    const started = upload.start()
    await vi.waitFor(() => expect(api.addFiles).toHaveBeenCalledOnce())
    upload.pause()
    await started
    expect(upload.getSnapshot()).toMatchObject({ phase: 'paused', files: [{ status: 'waiting' }] })
    await upload.start()
    expect(upload.getSnapshot()).toMatchObject({ phase: 'committed', files: [{ status: 'accepted' }] })
    expect(api.create).toHaveBeenCalledOnce()
  })

  it('cancels the import, and gives up when nothing could be taken', async () => {
    const api = fakeImports(async (_id: string, parts: { relativePath: string }[]) => ({ import: importRow, files: parts.map(part => ({ path: part.relativePath, status: 'rejected', reason: 'unsupported_type', bytes: 0 })) }))
    const upload = new Upload(api as never, [file('notes.txt')], { maxFileBytes: 1000 })
    await upload.start()
    expect(upload.getSnapshot()).toMatchObject({ phase: 'failed', error: 'None of these files can be imported.' })
    expect(api.cancel).toHaveBeenCalledWith(importRow.id)
    expect(api.commit).not.toHaveBeenCalled()

    const other = new Upload(fakeImports(async () => ({ import: importRow, files: [] })) as never, [file('a.flac')], { maxFileBytes: 1000 })
    const started = other.start()
    await other.cancel()
    await started
    expect(other.getSnapshot().phase).toBe('cancelled')
  })
})
