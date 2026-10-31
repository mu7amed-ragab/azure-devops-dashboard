import { useQuery } from '@tanstack/react-query';
import { fetchTeam } from './api';
import type { TeamResponse } from './types';
import { projectQueryKey } from './activeProject';

/** The lead/principal's own role plus their team (read-only — curated on
 * the Dashboard Roles wiki page, not in the app). `retry: false` — a 403
 * here means "not a lead/principal", an expected steady state rather than
 * a transient failure worth retrying. Forces a roles refresh and refetches
 * on every mount (server-side rate-limited to one wiki fetch per 30s) so a
 * person just added to the wiki shows up without waiting out
 * ROLES_CACHE_TTL_MS. */
export function useTeam() {
  return useQuery<TeamResponse>({
    queryKey: projectQueryKey('team'),
    queryFn: () => fetchTeam({ refresh: true }),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
}
