/**
 * What a screen reader says for a collection's tile or row: its title, whether it is pinned,
 * and its subtitle. Shared by both platforms' `BrowseControls`.
 */
export function collectionLabel({ title, subtitle, pinned }: { title: string; subtitle: string; pinned?: boolean }): string {
  return pinned ? `${title}, Pinned, ${subtitle}` : `${title}, ${subtitle}`;
}
