import { formatTotalDuration, isDraftGroup, plural, type Draft } from '@squirmy/client-core';
import type { SmartPlaylistRules } from '@squirmy/contracts';

/** What the editor says of how many songs the rules find, as the web's dialog does. */
export function matchCountLabel(rules: SmartPlaylistRules | null, preview: { trackCount: number; durationMs: number } | undefined, failed: boolean): string {
  if (!rules) return 'Finish the rules to see what matches';
  if (preview) return preview.trackCount ? `${plural(preview.trackCount, 'song')}, ${formatTotalDuration(preview.durationMs)}` : 'No songs match yet';
  return failed ? 'Couldn’t count the songs' : 'Counting songs…';
}

/** How many conditions the draft holds, groups' included: the server takes at most `SMART_CONDITION_LIMIT`. */
export function conditionCount(draft: Draft): number {
  return draft.rules.reduce((sum, rule) => sum + (isDraftGroup(rule) ? rule.conditions.length : 1), 0);
}
