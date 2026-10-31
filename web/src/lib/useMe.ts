import { usePeople } from './usePeople';
import type { LinkedIdentity, Role } from './types';

/** The PAT owner's own identity, role, and derived capabilities, sourced
 * from the same `['people']` query the Team page already loads — no
 * separate request. Every gate elsewhere in the app should read one of the
 * capability flags below, never compare `role` directly — see
 * server/org.js, whose capability helpers this mirrors. */
export function useMe(): {
  role: Role;
  displayName: string | null;
  uniqueName: string | null;
  isOwner: boolean;
  /** False only for a `scrum` account — hides Pull Requests everywhere
   * (nav, Dashboard tile, Team member sections) and gates the route. */
  canSeePullRequests: boolean;
  /** True for `lead`/`principal`/`scrum` — gates the Team page/nav item. */
  canSeeTeamPage: boolean;
  /** True for the dashboard owner or a `lead` — shows "Manage team". */
  canAdminOrg: boolean;
  /** 006-linked-identity-aliases (FR-009): other identities sharing this
   * person's username (e.g. a retired-domain account). Always an array —
   * [] for the common single-identity case, so most callers never need to
   * branch on it at all. */
  linkedIdentities: LinkedIdentity[];
  /** True only when identity-set discovery could not complete (FR-005). */
  identitiesDegraded: boolean;
  isLoading: boolean;
} {
  const { data, isLoading } = usePeople();
  const role = data?.self.role ?? null;
  const isOwner = data?.self.isOwner ?? false;
  return {
    role,
    displayName: data?.self.displayName ?? null,
    uniqueName: data?.self.uniqueName ?? null,
    isOwner,
    canSeePullRequests: data?.self.canSeePullRequests ?? true,
    canSeeTeamPage: data?.self.canSeeTeamPage ?? false,
    canAdminOrg: data?.self.canAdminOrg ?? false,
    linkedIdentities: data?.self.linkedIdentities ?? [],
    identitiesDegraded: data?.self.identitiesDegraded ?? false,
    isLoading,
  };
}
