import type { Import, ImportKind, ImportStep } from '@squirmy/contracts'
import { formatBytes, plural } from '@/lib/format'
import type { UploadRejection } from '@/lib/upload'

export const kindLabels: Record<ImportKind, string> = { upload: 'Upload', inbox: 'Inbox', acquisition: 'Provider' }

export const importSteps: { step: ImportStep | 'receiving'; label: string; active: string }[] = [
  { step: 'receiving', label: 'Received', active: 'Receiving files' },
  { step: 'extracting', label: 'Unpacked', active: 'Unpacking archives' },
  { step: 'moving', label: 'Moved', active: 'Moving into the library' },
  { step: 'identifying', label: 'Identified', active: 'Identifying albums' },
  { step: 'filing', label: 'Filed', active: 'Filing albums' },
]

export const isCancelled = (item: Import) => item.status === 'failed' && item.error === 'Cancelled'

/** Where an import is, in a few words. */
export function importState(item: Import): string {
  if (item.status === 'completed') return 'Done'
  if (isCancelled(item)) return 'Cancelled'
  if (item.status === 'failed') return 'Failed'
  return importSteps.find(step => step.step === (item.step ?? 'receiving'))!.active
}

/** The counts that matter, in one line: what was filed and what still needs someone. */
export function importSummary({ counts, status }: Import): string {
  const parts = [plural(counts.filesReceived, 'file') + (counts.bytesReceived ? ` · ${formatBytes(counts.bytesReceived)}` : '')]
  if (status !== 'completed') return parts[0]
  if (counts.albumsFiled) parts.push(`${plural(counts.albumsFiled, 'album')} filed`)
  if (counts.duplicatesSkipped) parts.push(`${plural(counts.duplicatesSkipped, 'duplicate')} skipped`)
  if (counts.filesLeftForReview) parts.push(`${plural(counts.filesLeftForReview, 'file')} left for review`)
  return parts.join(' · ')
}


export const rejectionLabels: Record<UploadRejection, string> = {
  unsupported_type: 'Not a music file',
  unsafe_path: 'Name not allowed',
  hidden: 'Hidden file',
  duplicate_name: 'Already in this upload',
  nested_archive: 'Zip inside a zip',
  unsafe_archive: 'Zip refused',
  unreadable_archive: 'Damaged zip',
  empty_file: 'Empty file',
  file_too_large: 'Too large',
  import_too_large: 'Over the upload limit',
}
