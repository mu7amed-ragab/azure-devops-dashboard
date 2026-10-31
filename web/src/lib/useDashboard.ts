import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDashboard, subscribeToUpdates } from './api';
import { loadPersistedDashboard, persistDashboard } from './queryClient';
import { projectQueryKey } from './activeProject';
import type { Dashboard } from './types';

export function queryKeyFor(personId: string | null) {
  return projectQueryKey('dashboard', personId ?? 'self');
}

/** No argument (or `null`) loads the PAT owner's own dashboard — the only
 * identity the app writes as. Pass an explicit id to load a specific
 * person regardless — the Team page's only use, mounting several people's
 * dashboards independently at once, each read-only. */
export function useDashboard(personId: string | null = null) {
  const queryClient = useQueryClient();
  const personKey = personId ?? 'self';
  const queryKey = queryKeyFor(personId);

  const query = useQuery<Dashboard>({
    queryKey,
    queryFn: () => fetchDashboard(personId),
    initialData: () => loadPersistedDashboard<Dashboard>(personKey)?.data,
    initialDataUpdatedAt: () => loadPersistedDashboard<Dashboard>(personKey)?.savedAt,
    // While the payload is `partial` (the fast first pass of a cold sync,
    // see server/sync.js), poll fast so the full pass's replacement shows up
    // within seconds rather than waiting out the normal 60s fallback poll.
    refetchInterval: (data) => (data?.partial ? 3000 : 60_000),
    // A cold sync (first look at a teammate, or the very first load) answers
    // 202 "SYNCING" — retry quickly rather than falling back to the 60s
    // interval or a one-shot error, so the loading state resolves itself
    // within a few seconds instead of up to a minute.
    retry: (failureCount, error) => error instanceof Error && error.message === 'SYNCING' && failureCount < 60,
    retryDelay: 2000,
  });

  useEffect(() => {
    // A partial payload must never become tomorrow's cold-load initialData —
    // it would render as complete (no isLoading, no `partial`-aware retry
    // cadence kicking in) until a real fetch eventually corrects it.
    if (query.data && !query.data.partial) persistDashboard(personKey, query.data);
  }, [query.data, personKey]);

  // SSE tells us data changed server-side; invalidate to refetch the small
  // payload rather than polling constantly. Compared against the currently
  // loaded dashboard's own person id (the real GUID either way — "self" is
  // only ever a client-side key) so a teammate's background sync doesn't
  // trigger a pointless refetch while you're viewing someone else. Before
  // the first load there's nothing to compare against, so any event is
  // taken at face value.
  //
  // The id is read through a ref rather than listed as a dependency: it
  // changes as soon as data arrives, and re-running this effect would
  // unsubscribe/resubscribe — which, for the last remaining subscriber,
  // closes and reopens the shared EventSource (see subscribeToUpdates).
  // One subscription per mounted hook, for as long as it is mounted.
  const currentPersonIdRef = useRef<string | undefined>(undefined);
  currentPersonIdRef.current = query.data?.person.id;

  useEffect(() => {
    const unsubscribe = subscribeToUpdates((updatedPersonId) => {
      const currentPersonId = currentPersonIdRef.current;
      if (!currentPersonId || updatedPersonId === currentPersonId) {
        queryClient.invalidateQueries({ queryKey });
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, personKey]);

  return query;
}
