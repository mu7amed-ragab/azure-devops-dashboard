import { useQuery } from '@tanstack/react-query';
import { fetchAuthMe } from './api';

/** Drives the login gate (see LoginPage/RequireAuth): `stage: 'ready'`
 * means the visitor either has a valid session or auth is disabled
 * entirely (local dev). Never retries — a failed check should fall through
 * to the login form immediately, not spin. */
export function useAuth() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: fetchAuthMe,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
}
