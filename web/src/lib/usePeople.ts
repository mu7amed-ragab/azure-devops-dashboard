import { useQuery } from '@tanstack/react-query';
import { fetchPeople } from './api';
import { projectQueryKey } from './activeProject';

/** The project's people list, shared by the person picker and anywhere
 * else that needs to resolve an id to a display name (e.g. the loading
 * copy while a teammate's dashboard is syncing). Refetches with a forced
 * roles refresh on every mount — cheap (server-side rate-limited to one
 * wiki fetch per 30s, and the people list itself stays on its own 24h
 * cache) — so a brand-new lead sees the Team nav item without a 10-minute
 * wait or a restart. */
export function usePeople() {
  return useQuery({
    queryKey: projectQueryKey('people'),
    queryFn: () => fetchPeople({ refresh: true }),
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
