import { patchEntities, planChanges } from '@squirmy/client-core'
import type { EntityChange } from '@squirmy/contracts'
import type { QueryClient } from '@tanstack/react-query'

/**
 * Applies the server's `changes` to the query cache: values it carries are set on every
 * cached copy of the entity, in place, so rows turn gray or playable, hearts and library
 * marks follow, and no list reorders or is fetched again; an entity's own page is refetched
 * when only it shows what changed; a page whose entity is gone is reset, so it says so
 * instead of keeping the old copy. Search answers are patched like any other and never run
 * again for a change.
 */
export function applyChanges(queryClient: QueryClient, changes: readonly EntityChange[]) {
  const plan = planChanges(changes)
  if (plan.patches.size > 0) {
    for (const query of queryClient.getQueryCache().getAll()) {
      const data = query.state.data
      if (data === undefined) continue
      const patched = patchEntities(data, plan.patches)
      // Keeps the time the data was loaded: a patch does not make the rest of it fresh.
      if (patched !== data) queryClient.setQueryData(query.queryKey, patched, { updatedAt: query.state.dataUpdatedAt })
    }
  }
  for (const queryKey of plan.refetch) void queryClient.invalidateQueries({ queryKey })
  for (const queryKey of plan.gone) void queryClient.resetQueries({ queryKey })
}
