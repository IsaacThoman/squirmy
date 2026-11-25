import type { ServerEvent } from '@squirmy/contracts';

type ScanEvent = Extract<ServerEvent, { type: 'scan.progress' }>;
/** Files read so far, and how many there are, across the library folders being scanned. */
export type ScanProgress = { processed: number; total: number };
export type ScanRoots = Readonly<Record<string, ScanProgress>>;

/** The folders being scanned once `event` is in: a folder that went idle is done and leaves. */
export function scanRoots(roots: ScanRoots, event: ScanEvent): ScanRoots {
  const { [event.rootId]: _done, ...rest } = roots;
  return event.phase === 'idle' ? rest : { ...rest, [event.rootId]: { processed: event.processed, total: event.total } };
}

/** Every folder being scanned added together; null when none is, or none has counted its files yet. */
export function scanTotal(roots: ScanRoots): ScanProgress | null {
  const scans = Object.values(roots);
  const total = scans.reduce((sum, scan) => sum + scan.total, 0);
  return total > 0 ? { processed: scans.reduce((sum, scan) => sum + scan.processed, 0), total } : null;
}
