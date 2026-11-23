import { patchEntities, type ChangePlan } from '@squirmy/client-core';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Applies the server's `changes` (planned by client-core's `planChanges`) to the query
 * cache: values they carry are set on every cached copy of the entity in place, so rows
 * turn gray or playable and hearts and library marks follow without a list moving or being
 * fetched again; an entity's own page is refetched when only it shows what changed; a page
 * whose entity is gone is reset, so it says so instead of keeping the old copy.
 */
export function applyChanges(queryClient: QueryClient, plan: ChangePlan, { own }: { own: boolean }): void {
  if (plan.patches.size > 0) {
    for (const query of queryClient.getQueryCache().getAll()) {
      const data = query.state.data;
      if (data === undefined) continue;
      const patched = patchEntities(data, plan.patches);
      // Keeps the time the data was loaded: a patch does not make the rest of it fresh.
      if (patched !== data) queryClient.setQueryData(query.queryKey, patched, { updatedAt: query.state.dataUpdatedAt });
    }
  }
  // As with invalidations, this device's own change is only marked stale.
  for (const queryKey of plan.refetch) void queryClient.invalidateQueries({ queryKey, refetchType: own ? 'none' : 'active' });
  for (const queryKey of plan.gone) void queryClient.resetQueries({ queryKey });
}
