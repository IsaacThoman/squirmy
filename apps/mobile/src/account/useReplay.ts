import { queryKeys, type TrackSummary } from '@squirmy/contracts';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { loadFailure } from '../data/errors';
import { pageHref, useCurrentTab } from '../library/links';
import { usePlaybackActions } from '../playback';
import { useSignedInApi } from './AccountProvider';
import type { ReplayChoice } from './replay';

/**
 * Replay's numbers for a period (`GET /me/replay`), in the device's time zone, and what its
 * rows do: a song plays, an artist or album opens its page under the sheets.
 */
export function useReplay() {
  const api = useSignedInApi();
  const router = useRouter();
  const tab = useCurrentTab();
  const actions = usePlaybackActions();
  const [period, setPeriod] = useState<ReplayChoice>('month');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const query = useQuery({
    queryKey: [...queryKeys.replay(), { period, tz }],
    queryFn: () => api!.userdata.replay({ period, tz }),
    enabled: Boolean(api),
  });
  const failure = query.isError && !query.data ? loadFailure(query.error) : null;
  return {
    period, setPeriod, tz, stats: query.data, pending: query.isPending,
    failure: failure && { description: failure.description, retry: failure.retry ? () => void query.refetch() : null },
    // Opened over the account sheet: both close before the page opens beneath, as Downloads does.
    open: (page: 'artist' | 'album', id: string) => {
      router.dismissAll();
      router.navigate(pageHref(tab, page, id));
    },
    play: (track: TrackSummary) => actions.playTracks([track], { start: 0, context: { type: 'other', id: null, title: 'Replay' } }),
  };
}
