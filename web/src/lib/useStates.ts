import { useQuery } from '@tanstack/react-query';
import { fetchStates } from './api';
import { projectQueryKey } from './activeProject';

/** Real per-type workflow states from Azure DevOps — fetched once and
 * reused everywhere a state picker is shown, never hardcoded client-side. */
export function useStates() {
  return useQuery({ queryKey: projectQueryKey('states'), queryFn: fetchStates, staleTime: 60 * 60 * 1000 });
}
