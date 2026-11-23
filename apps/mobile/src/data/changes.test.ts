import { planChanges } from '@squirmy/client-core';
import { queryKeys, type EntityChange } from '@squirmy/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { applyChanges } from './changes';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number) => ({ id: id(n), title: `Song ${n}`, availability: 'on_demand', liked: false, inLibrary: false, library: null });

describe('applyChanges', () => {
  it('patches rows in place without fetching or reordering, keeping when the data was loaded', () => {
    const client = new QueryClient();
    const search = [...queryKeys.search(), 'catalog', 'radiohead'];
    client.setQueryData(search, { tracks: [row(1), row(2), row(3)] }, { updatedAt: 1000 });
    const fetch = vi.spyOn(client, 'invalidateQueries');
    const changes: EntityChange[] = [
      { kind: 'availability', tracks: [{ id: id(2), availability: 'none' }], albums: [] },
      { kind: 'patch', entity: 'track', id: id(3), fields: { liked: true, inLibrary: true, library: 'saved' } },
    ];
    applyChanges(client, planChanges(changes), { own: false });
    const data = client.getQueryData<{ tracks: ReturnType<typeof row>[] }>(search)!;
    expect(data.tracks.map(track => track.id)).toEqual([id(1), id(2), id(3)]);
    expect(data.tracks[1]).toMatchObject({ availability: 'none' });
    expect(data.tracks[2]).toMatchObject({ liked: true, inLibrary: true, library: 'saved' });
    expect(client.getQueryState(search)!.dataUpdatedAt).toBe(1000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refetches the page of an updated entity, only marking it stale for a change made here', () => {
    const client = new QueryClient();
    const fetch = vi.spyOn(client, 'invalidateQueries');
    const changes: EntityChange[] = [{ kind: 'updated', entity: 'album', ids: [id(9)] }];
    applyChanges(client, planChanges(changes), { own: false });
    expect(fetch).toHaveBeenLastCalledWith({ queryKey: queryKeys.album(id(9)), refetchType: 'active' });
    applyChanges(client, planChanges(changes), { own: true });
    expect(fetch).toHaveBeenLastCalledWith({ queryKey: queryKeys.album(id(9)), refetchType: 'none' });
  });

  it('drops the old copy of a playlist deleted on another device', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.playlist(id(5)), { id: id(5), name: 'Gone', items: [] });
    applyChanges(client, planChanges([{ kind: 'deleted', entity: 'playlist', ids: [id(5)] }]), { own: false });
    expect(client.getQueryData(queryKeys.playlist(id(5)))).toBeUndefined();
  });
});
