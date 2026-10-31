import type { OrgMember, Role } from '../../../lib/types';
import { t } from '../../../lib/i18n';

export type OrgRole = Exclude<Role, null>;

/** The one place an `OrgRole` maps to display text (FR-009) — the
 * `team.roleName*` catalog entries, not a `label` field on these options,
 * so a component picking up a fresh `lang` always reads the current
 * translation instead of one baked in when the option list was built. */
export function roleLabel(role: OrgRole): string {
  switch (role) {
    case 'developer':
      return t('team.roleNameDeveloper');
    case 'lead':
      return t('team.roleNameLead');
    case 'principal':
      return t('team.roleNamePrincipal');
    case 'scrum':
      return t('team.roleNameScrum');
  }
}

// Plain data (no `label`) so this stays usable outside a component —
// callers resolve display text via `roleLabel(value)`.
export const ALL_ROLE_OPTIONS: { value: OrgRole }[] = [
  { value: 'developer' },
  { value: 'lead' },
  { value: 'principal' },
  { value: 'scrum' },
];

/** Options for a role <select>, filtered to what the caller may actually
 * assign (server/org.js's ASSIGNABLE_ROLES, echoed back on OrgResponse as
 * `assignableRoles`) plus the target's current role, if any — so editing an
 * existing member never silently drops a role the caller didn't grant. */
export function roleOptionsFor(assignable: OrgRole[], currentRole?: OrgRole): { value: OrgRole }[] {
  const allowed = new Set(assignable);
  if (currentRole) allowed.add(currentRole);
  return ALL_ROLE_OPTIONS.filter((o) => allowed.has(o.value));
}

/** Every id reachable below `id` by following `parentId` — used so a member
 * can't be re-parented under one of their own descendants (the server
 * enforces this too; this is only for not offering the choice). */
export function descendantIds(members: OrgMember[], id: string): Set<string> {
  const byParent = new Map<string, OrgMember[]>();
  for (const m of members) {
    const key = m.parentId ?? '';
    const list = byParent.get(key) ?? [];
    list.push(m);
    byParent.set(key, list);
  }
  const result = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const child of byParent.get(current) ?? []) {
      if (!result.has(child.id)) {
        result.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return result;
}

/** Which roles may report to a member holding a given role — mirrors
 * ROLES_ALLOWED_UNDER in server/org.js, which is the actual enforcement
 * point. This copy exists only so the UI never offers a combination the
 * server would reject. Keep the two in sync. */
export const ROLES_ALLOWED_UNDER: Record<OrgRole, OrgRole[]> = {
  lead: ['developer', 'lead', 'principal', 'scrum'],
  principal: ['developer'],
  scrum: [],
  developer: [],
};

export function rolesAllowedUnder(parentRole: OrgRole | undefined): OrgRole[] {
  return parentRole ? ROLES_ALLOWED_UNDER[parentRole] ?? [] : [];
}

/** Seniority for classifying a role *change* — mirrors ROLE_RANK in
 * server/org.js. `scrum` shares a rank with `developer` on purpose: a
 * separate track, not a rung, so moving between the two is sideways either
 * way while lead → scrum stays a demotion. */
const ROLE_RANK: Record<OrgRole, number> = { developer: 1, scrum: 1, principal: 2, lead: 3 };

export function roleChangeKind(from: OrgRole, to: OrgRole): 'promotion' | 'lateral' | 'demotion' {
  if (ROLE_RANK[to] > ROLE_RANK[from]) return 'promotion';
  if (ROLE_RANK[to] < ROLE_RANK[from]) return 'demotion';
  return 'lateral';
}

/** A role change that crosses into or out of the `scrum` track, in either
 * direction — mirrors crossesScrumTrack in server/org.js, which is the
 * actual enforcement point. Neither direction is a change of seniority: the
 * scrum runs ceremonies rather than carrying the team's work, so a developer
 * (or principal, or lead) is never "promoted to scrum" and the scrum is never
 * "demoted to developer". Both are done by removing the row and adding it
 * again. This copy exists only so the UI doesn't offer a choice the server
 * would reject. Keep the two in sync. */
export function crossesScrumTrack(from: OrgRole, to: OrgRole): boolean {
  if (from === to) return false;
  return from === 'scrum' || to === 'scrum';
}

/** Role options when editing someone who already exists, as opposed to
 * placing a new person (roleOptionsUnder).
 *
 * Deliberately NOT bounded by the current parent: in the edit form the role
 * is what drives the "Reports to" list (see managerOptionsFor), not the other
 * way round. Filtering in both directions at once would let one field trap
 * the other — pick a role and the only legal manager disappears, or vice
 * versa. Role first, managers second, one direction only.
 *
 * Someone who heads a team has no options at all: the team is defined by
 * their role, so it changes by changing the team's manager instead.
 *
 * A demotion is offered even when the person has reports — it isn't silently
 * hidden, because the server answers that case with the "N people move to …"
 * confirmation, which is the whole point of that exchange. */
export function roleChangeOptionsFor(assignable: OrgRole[], member: { role: OrgRole }, headsTeam: boolean): { value: OrgRole }[] {
  const current = ALL_ROLE_OPTIONS.filter((o) => o.value === member.role);
  // A scrum's role is pinned for the same reason its rank is off the ladder:
  // it is a separate track, so there is no promotion or demotion out of it.
  if (headsTeam || member.role === 'scrum') return current;
  // …and the same rule read the other way: nobody is converted INTO the
  // scrum either, so it is not offered to a developer, principal or lead.
  // Adding a scrum is done from "+ Add Member" (roleOptionsUnder), which is
  // a new membership rather than a conversion of this one.
  const base = roleOptionsFor(assignable, member.role).filter((o) => !crossesScrumTrack(member.role, o.value));
  return base.length > 0 ? base : current;
}

/** Display order within one level of a team: lead, then scrum, then
 * principal, then developers — seniority descending, with the scrum sitting
 * directly under the lead they serve. Deliberately NOT ROLE_RANK, which
 * exists to classify a role *change* and puts scrum level with developer;
 * this one is about reading order and nothing else. */
const ROLE_DISPLAY_ORDER: Record<OrgRole, number> = { lead: 0, scrum: 1, principal: 2, developer: 3 };

export function byRoleThenName(a: OrgMember, b: OrgMember): number {
  const rank = ROLE_DISPLAY_ORDER[a.role] - ROLE_DISPLAY_ORDER[b.role];
  return rank !== 0 ? rank : a.displayName.localeCompare(b.displayName);
}

/** Who may appear in "Reports to" for a member of `role` on `teamId`: people
 * on that team who can have reports at all, PLUS the team's own manager
 * (whose `teamId` points elsewhere, or nowhere, because they head the team
 * rather than belonging to it) — narrowed to those the role may legally sit
 * under.
 *
 * That last filter is the point. A scrum may only report to a team lead, so
 * a principal must not be offered and then rejected with "Only a developer
 * can report to a principal" after the fact — an option you are not allowed
 * to choose should not be in the list. server/orgStore.js still enforces it.
 *
 * `exclude` keeps a member out of their own subtree (and off their own row). */
export function managerOptionsFor(
  members: OrgMember[],
  teams: { id: string; managerMemberId: string | null }[],
  role: OrgRole,
  teamId: string,
  exclude: Set<string>
): OrgMember[] {
  const team = teams.find((t) => t.id === teamId);
  return members.filter((m) => {
    if (exclude.has(m.id)) return false;
    if (!rolesAllowedUnder(m.role).includes(role)) return false;
    const headsThisTeam = !!team && team.managerMemberId === m.id;
    return headsThisTeam || (m.teamId ?? '') === teamId;
  });
}

/** Role <select> options for adding/editing someone under `parentRole`:
 * what the caller may assign, intersected with what may legally sit under
 * that parent. */
export function roleOptionsUnder(assignable: OrgRole[], parentRole: OrgRole | undefined, currentRole?: OrgRole) {
  const allowedHere = new Set(rolesAllowedUnder(parentRole));
  return roleOptionsFor(assignable, currentRole).filter((o) => allowedHere.has(o.value) || o.value === currentRole);
}

export interface FlattenedMember {
  member: OrgMember;
  depth: number;
}

/** Every member of `teamId`, in the same depth-first order `PeopleTree`
 * visits them — walked down `parentId` from the team's manager so the flat
 * List view and the Hierarchy view can never disagree.
 *
 * Membership comes from `teamId`, never from the parent chain: a lead may
 * head several teams, and deriving the roster from their descendants (as
 * this used to) made every one of those teams show the same people. Anyone
 * whose parent falls outside the team is appended rather than dropped, so a
 * broken relationship stays visible and fixable.
 *
 * Siblings are ordered by seniority (byRoleThenName), so both this list and
 * the tree read top-down: lead, scrum, principal, developers. */
export function flattenRoster(members: OrgMember[], managerId: string, teamId: string | null): FlattenedMember[] {
  const inTeam = members.filter((m) => (m.teamId ?? null) === teamId && m.id !== managerId);
  const byParent = new Map<string, OrgMember[]>();
  for (const m of inTeam) {
    const key = m.parentId ?? '';
    const list = byParent.get(key) ?? [];
    list.push(m);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort(byRoleThenName);
  const result: FlattenedMember[] = [];
  const seen = new Set<string>();
  function visit(parentId: string, depth: number) {
    for (const child of byParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      result.push({ member: child, depth });
      visit(child.id, depth + 1);
    }
  }
  visit(managerId, 0);
  for (const m of inTeam.filter((x) => !seen.has(x.id)).sort(byRoleThenName)) {
    result.push({ member: m, depth: 0 });
  }
  return result;
}

/** Candidates for "Reports to" within one team — the team's manager plus
 * everyone else on that team who can actually have reports. */
export function nonDeveloperRosterFor(members: OrgMember[], managerId: string, teamId: string | null): OrgMember[] {
  const manager = members.find((m) => m.id === managerId);
  const rest = flattenRoster(members, managerId, teamId)
    .map((r) => r.member)
    .filter((m) => rolesAllowedUnder(m.role).length > 0);
  return manager ? [manager, ...rest] : rest;
}

/** Who may head a team: a `lead`, and only a `lead`. It follows from the
 * reporting matrix — a team's members hang off its manager, and nobody but a
 * lead may have a lead, principal or scrum beneath them. A principal or scrum
 * at the head of a team could hold developers and nothing else, which is a
 * discipline rather than a team. Enforced in server/orgStore.js
 * (_assertValidManager); this keeps the ineligible out of the picker. */
export function teamManagerOptions(members: OrgMember[]): OrgMember[] {
  return members.filter((m) => m.role === 'lead');
}

export const inputClass = 'focus-ring w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-ink';
export const labelClass = 'mb-1 block text-xs font-medium text-ink-subtle';
