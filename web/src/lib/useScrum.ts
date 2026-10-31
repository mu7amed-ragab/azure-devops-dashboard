import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchScrumSprints,
  fetchScrumVelocity,
  fetchScrumProgress,
  fetchScrumUtilisation,
  fetchScrumBurndown,
  fetchScrumImpediments,
  fetchScrumScopeChange,
  fetchBlockedConvention,
  saveBlockedConvention,
} from './api';
import { projectQueryKey } from './activeProject';
import type { BlockedConvention } from './types';

/** One hook per Scrum view (FR-006a) — a failure in one card's query must
 * never blank a sibling card, which requires each to be its own React
 * Query entry rather than one page-wide fetch. `retry: false` mirrors
 * useTeam: a 403 here means "not a lead/principal/scrum", an expected
 * steady state. */
export function useScrumSprints() {
  return useQuery({
    queryKey: projectQueryKey('scrum', 'sprints'),
    queryFn: fetchScrumSprints,
    retry: false,
  });
}

export function useScrumVelocity(windowSize?: number) {
  return useQuery({
    queryKey: projectQueryKey('scrum', 'velocity', windowSize ?? null),
    queryFn: () => fetchScrumVelocity(windowSize),
    retry: false,
  });
}

export function useScrumProgress(sprintPath: string | null) {
  return useQuery({
    queryKey: projectQueryKey('scrum', 'progress', sprintPath),
    queryFn: () => fetchScrumProgress(sprintPath),
    retry: false,
    enabled: sprintPath !== undefined,
  });
}

export function useScrumUtilisation(sprintPath: string | null) {
  return useQuery({
    queryKey: projectQueryKey('scrum', 'utilisation', sprintPath),
    queryFn: () => fetchScrumUtilisation(sprintPath),
    retry: false,
  });
}

export function useScrumBurndown(sprintPath: string | null) {
  return useQuery({
    queryKey: projectQueryKey('scrum', 'burndown', sprintPath),
    queryFn: () => fetchScrumBurndown(sprintPath),
    retry: false,
  });
}

export function useScrumImpediments(sprintPath: string | null) {
  return useQuery({
    queryKey: projectQueryKey('scrum', 'impediments', sprintPath),
    queryFn: () => fetchScrumImpediments(sprintPath),
    retry: false,
  });
}

export function useScrumScopeChange(sprintPath: string | null) {
  return useQuery({
    queryKey: projectQueryKey('scrum', 'scope-change', sprintPath),
    queryFn: () => fetchScrumScopeChange(sprintPath),
    retry: false,
  });
}

export function useBlockedConvention(sprintPath: string | null) {
  return useQuery({
    queryKey: projectQueryKey('scrum', 'blocked-convention', sprintPath),
    queryFn: () => fetchBlockedConvention(sprintPath),
    retry: false,
  });
}

/** The feature's only write (FR-006g) — saving invalidates impediments (its
 * result depends on the convention) and the convention query itself. */
export function useSaveBlockedConvention(sprintPath: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (convention: BlockedConvention) => saveBlockedConvention(convention, sprintPath),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: projectQueryKey('scrum', 'blocked-convention') });
      queryClient.invalidateQueries({ queryKey: projectQueryKey('scrum', 'impediments') });
    },
  });
}
