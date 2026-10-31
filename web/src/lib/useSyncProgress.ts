import { useQuery } from '@tanstack/react-query';
import { fetchSyncProgress } from './api';
import { projectQueryKey } from './activeProject';

/** Polls GET /api/sync/progress while `enabled` — a sync is either running
 * (202 first load) or the loaded dashboard is still `partial`. Stops on its
 * own once the server reports nothing in flight, as a backstop in case the
 * caller's own `enabled` gate is a beat slow to flip off. */
export function useSyncProgress(personId: string | null, enabled: boolean) {
  const query = useQuery({
    queryKey: projectQueryKey('sync-progress', personId ?? 'self'),
    queryFn: () => fetchSyncProgress(personId),
    enabled,
    refetchInterval: (data) => (data !== null ? 1500 : false),
    staleTime: 0,
    retry: false,
  });
  return query.data ?? null;
}
