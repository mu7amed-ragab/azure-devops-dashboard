import { useQuery } from '@tanstack/react-query';
import { fetchCrossHours } from './api';
import type { CrossHoursResponse } from './types';

/**
 * Cross-project hours (GET /api/hours/cross) — for the signed-in person, or
 * for `personId` on the Team page.
 *
 * Deliberately NOT keyed by project (`projectQueryKey`): this is the one
 * payload in the app that spans every project, so it stays valid across a
 * project switch instead of being thrown away with the rest of that project's
 * cache. It IS keyed by person, so several open Team sections don't overwrite
 * each other's answer; a sign-out clears the whole query cache.
 *
 * Polls every 2s while the server reports `building` (a first build walks
 * every project's revision history) and stops the moment a result exists.
 * `enabled` is what makes this cost nothing until someone actually opens the
 * All projects tab.
 */
export function useCrossHours(enabled: boolean, personId?: string | null) {
  return useQuery<CrossHoursResponse>({
    queryKey: ['cross-hours', personId ?? 'self'],
    queryFn: () => fetchCrossHours(personId),
    enabled,
    refetchInterval: (data) => (data && data.status === 'building' ? 2000 : false),
    // A stale result is served instantly and rebuilt server-side, so there is
    // nothing to gain from refetching on every remount of the card.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
