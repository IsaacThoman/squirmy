import type { Page, TrackSummary } from '@squirmy/contracts';
import type { InfiniteData } from '@tanstack/react-query';

/**
 * A copy of `data` in which every object whose `id` is `id` has the fields of `patch` it
 * already carries set to their new values. Unchanged parts keep their identity, and the
 * same `data` comes back when nothing matched. Ids are UUIDs, unique across entity types,
 * so one call updates a like everywhere it shows. The web app's `patchEntity`, for the same job.
 */
export function patchEntity<T>(data: T, id: string, patch: Record<string, unknown>): T {
  if (Array.isArray(data)) {
    let changed = false;
    const next = data.map(item => {
      const patched = patchEntity(item, id, patch);
      if (patched !== item) changed = true;
      return patched;
    });
    return (changed ? next : data) as T;
  }
  if (!data || typeof data !== 'object') return data;
  const record = data as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  if (record.id === id) {
    for (const [key, value] of Object.entries(patch)) {
      if (key in record && record[key] !== value) (next ??= { ...record })[key] = value;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (!value || typeof value !== 'object') continue;
    const patched = patchEntity(value, id, patch);
    if (patched !== value) (next ??= { ...record })[key] = patched;
  }
  return (next ?? data) as T;
}

function isTrack(value: Record<string, unknown>): boolean {
  return typeof value.durationMs === 'number' && typeof value.artistCredit === 'string' && 'availability' in value;
}

/** The first track summary with this id anywhere in `data`. */
export function findTrack(data: unknown, id: string): TrackSummary | undefined {
  if (!data || typeof data !== 'object') return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findTrack(item, id);
      if (found) return found;
    }
    return undefined;
  }
  const record = data as Record<string, unknown>;
  if (record.id === id && isTrack(record)) return record as TrackSummary;
  for (const value of Object.values(record)) {
    const found = findTrack(value, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * The Liked Songs list after a like (`track`, newest first, so at the top) or an unlike of
 * `id` (removed from whichever page holds it). The same list comes back when nothing changes.
 */
export function withLikedTrack(
  data: InfiniteData<Page<TrackSummary>>, id: string, track: TrackSummary | null,
): InfiniteData<Page<TrackSummary>> {
  const has = data.pages.some(page => page.items.some(item => item.id === id));
  if (track) {
    if (has || !data.pages.length) return data;
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first!, items: [{ ...track, liked: true }, ...first!.items] }, ...rest] };
  }
  if (!has) return data;
  return { ...data, pages: data.pages.map(page => page.items.some(item => item.id === id)
    ? { ...page, items: page.items.filter(item => item.id !== id) }
    : page) };
}
