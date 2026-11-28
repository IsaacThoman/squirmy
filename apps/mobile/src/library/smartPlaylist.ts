import {
  emptyDraft, isDraftGroup, newCondition, newGroup, toDraft, toRules, type Draft, type DraftCondition, type DraftRule,
} from '@squirmy/client-core';
import { SMART_CONDITION_LIMIT, type PlaylistDetail, type PlaylistSummary } from '@squirmy/contracts';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSignedInApi } from '../account/AccountProvider';
import { loadFailure } from '../data/errors';
import { usePlaylistActions } from '../data/library';
import { conditionCount, matchCountLabel } from './smartPlaylistText';

/** `value`, once it has stayed the same for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [ms, value]);
  return settled;
}

/**
 * A smart playlist's editor, with the web's rule model (client-core's `smart-rules`): its
 * name, description, visibility and rules, how many songs they find (asked once typing stops),
 * and saving. `playlist` is the one being edited; without it the editor makes one.
 */
export function useSmartPlaylistEditor(playlist: PlaylistDetail | undefined, onSaved: (playlist: PlaylistSummary) => void) {
  const api = useSignedInApi();
  const edits = usePlaylistActions();
  const [name, setName] = useState(playlist?.name ?? '');
  const [description, setDescription] = useState(playlist?.description ?? '');
  const [isPublic, setPublic] = useState(playlist?.isPublic ?? false);
  const [draft, setDraft] = useState<Draft>(() => (playlist?.rules ? toDraft(playlist.rules) : emptyDraft()));
  // Rules still to finish are marked once Save was tried, not while they are typed.
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const built = useMemo(() => toRules(draft), [draft]);
  const rules = 'rules' in built ? built.rules : null;
  const settled = useSettled(rules, 400);
  const preview = useQuery({
    queryKey: ['smart-preview', settled],
    queryFn: () => api!.userdata.previewSmartPlaylist(settled!),
    enabled: Boolean(api) && settled !== null,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const canAdd = conditionCount(draft) < SMART_CONDITION_LIMIT;

  const change = (next: Partial<Draft>) => setDraft(current => ({ ...current, ...next }));
  /** Replaces the rule (null removes it); a group left with no conditions goes too. */
  const changeRule = (key: string, edit: (rule: DraftRule) => DraftRule | null) => setDraft(current => ({
    ...current,
    rules: current.rules.flatMap(rule => {
      if (rule.key !== key) return [rule];
      const next = edit(rule);
      return next && (!isDraftGroup(next) || next.conditions.length) ? [next] : [];
    }),
  }));
  const changeCondition = (groupKey: string | null, key: string, next: DraftCondition | null) => {
    if (!groupKey) return changeRule(key, () => next);
    changeRule(groupKey, group => isDraftGroup(group)
      ? { ...group, conditions: group.conditions.flatMap(condition => (condition.key === key ? (next ? [next] : []) : [condition])) }
      : group);
  };

  return {
    name, setName, description, setDescription, isPublic, setPublic, draft, change, canAdd,
    unfinished: tried && 'unfinished' in built ? built.unfinished : new Set<string>(),
    badLimit: tried && 'badLimit' in built && built.badLimit,
    matchCount: matchCountLabel(rules, preview.data, preview.isError),
    saving, failure,
    addRule: () => change({ rules: [...draft.rules, newCondition()] }),
    addGroup: () => change({ rules: [...draft.rules, newGroup()] }),
    addToGroup: (groupKey: string) => changeRule(groupKey, group => (isDraftGroup(group) ? { ...group, conditions: [...group.conditions, newCondition()] } : group)),
    removeRule: (key: string) => changeRule(key, () => null),
    changeRule,
    changeCondition,
    save: async () => {
      setTried(true);
      if (!rules || !name.trim() || saving) return;
      setSaving(true);
      setFailure(null);
      try {
        onSaved(await edits.saveSmart(playlist?.id ?? null, { name: name.trim(), description: description.trim() || null, isPublic, rules }));
      } catch (error) {
        setFailure(loadFailure(error).description);
      } finally {
        setSaving(false);
      }
    },
  };
}

export type SmartPlaylistEditor = ReturnType<typeof useSmartPlaylistEditor>;
