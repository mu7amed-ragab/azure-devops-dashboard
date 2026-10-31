import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchOrg,
  createOrgTeam,
  updateOrgTeam,
  deleteOrgTeam,
  createOrgMember,
  updateOrgMember,
  deleteOrgMember,
  type CreateOrgMemberInput,
  type UpdateOrgMemberPatch,
} from './api';
import type { OrgResponse, OrgTeam } from './types';
import { projectQueryKey } from './activeProject';

/** The caller's own subtree of the org chart — see ManageTeamModal.tsx. */
export function useOrg() {
  return useQuery<OrgResponse>({
    queryKey: projectQueryKey('org'),
    queryFn: fetchOrg,
    staleTime: 0,
  });
}

/** Every mutation invalidates `org`, `people`, and `team` — a role or
 * reporting-line change should be reflected immediately, both behind the
 * modal (the roster tree) and everywhere else useMe()/useTeam() read from
 * (nav items, the Team page roster). */
export function useOrgMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: projectQueryKey('org') });
    queryClient.invalidateQueries({ queryKey: projectQueryKey('people') });
    queryClient.invalidateQueries({ queryKey: projectQueryKey('team') });
  };

  const createTeam = useMutation({
    mutationFn: ({ name, managerMemberId }: { name: string; managerMemberId: string }) => createOrgTeam(name, managerMemberId),
    onSuccess: invalidate,
  });
  const renameTeam = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Omit<OrgTeam, 'id'>> }) => updateOrgTeam(id, patch),
    onSuccess: invalidate,
  });
  const removeTeam = useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade?: boolean }) => deleteOrgTeam(id, cascade),
    onSuccess: invalidate,
  });
  const addMember = useMutation({
    mutationFn: (input: CreateOrgMemberInput) => createOrgMember(input),
    onSuccess: invalidate,
  });
  const editMember = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateOrgMemberPatch }) => updateOrgMember(id, patch),
    onSuccess: invalidate,
  });
  const removeMember = useMutation({
    mutationFn: (id: string) => deleteOrgMember(id),
    onSuccess: invalidate,
  });

  return { createTeam, renameTeam, removeTeam, addMember, editMember, removeMember };
}
