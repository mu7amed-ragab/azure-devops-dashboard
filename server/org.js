/**
 * Pure logic over the org chart shape stored by server/orgStore.js — no file
 * I/O, no network. Kept separate from orgStore.js so the recursion/validation
 * rules can be reasoned about (and unit-tested) without a filesystem.
 *
 * Shape:
 *   { version, updatedAt, teams: [{id, name, managerMemberId}], members:
 *     [{id, email, displayName, role, teamId, parentId}] }
 *
 * `role` is one of VALID_ROLES.
 *
 * TEAM MEMBERSHIP AND THE REPORTING LINE ARE TWO SEPARATE EDGES:
 *
 *   - `teamId` is membership, and it is authoritative. A team's roster is
 *     exactly the members carrying that team's id — see teamRosterFor.
 *   - `parentId` is the reporting line *within* one team. It orders a
 *     roster; it never decides who is in it.
 *
 * This used to be conflated: rosters were derived purely by walking
 * `parentId` down from a team's manager, so one person managing three teams
 * made all three show the same people (every member of any of them hung off
 * that one manager). A lead may head any number of teams, so `_validateMemberFields`
 * keeps the two edges coherent instead: a member's parent must be their own
 * team's manager or another member of that same team.
 *
 * Two kinds of row legitimately carry `teamId: null` — the owner's root row,
 * and anyone who *manages* a team (a lead of three teams cannot be expressed
 * by a single teamId).
 *
 * A MEMBER ROW IS ONE MEMBERSHIP, NOT ONE PERSON. Someone can belong to
 * several teams at once, and they do it by having one row per team — same
 * email, different id, and independently their own `teamId`, `parentId` and
 * `role`. So a person may be a principal in one team and a developer in
 * another, reporting to a different lead in each, and removing them from one
 * team leaves the others untouched. Rows are therefore unique on
 * (email, teamId), not on email alone.
 *
 * Anything that answers a question about a PERSON rather than a membership
 * has to fold those rows together — see findMembersByEmail and rolesMapFrom.
 *
 * A team's `managerMemberId` names the member who heads it — required, and
 * used to scope who may edit/rename/delete the team (see
 * OrgStore.assertCanManageTeam).
 */

const VALID_ROLES = new Set(['developer', 'lead', 'principal', 'scrum']);

/** Capabilities derived from a role — every call site should read one of
 * these, never compare `role === '…'` directly, so a new role only has to
 * update this one place. */
const ROLE_CAPABILITIES = {
  developer: new Set([]),
  lead: new Set(['teamPage', 'adminOrg']),
  principal: new Set(['teamPage']),
  scrum: new Set(['teamPage']),
};

/** Which roles each actor may create or assign to someone else, keyed by the
 * actor's own role (`'owner'` for the dashboard owner, who is not a role in
 * VALID_ROLES). Only the owner may create/promote a `lead` or restructure
 * outside their own subtree. `principal` and `scrum` are view-only — they
 * have no `adminOrg` capability, so they never reach a route that would
 * consult this table, but they're omitted here too so the table can't be
 * misread as granting them staffing rights. */
const ASSIGNABLE_ROLES = {
  owner: ['developer', 'principal', 'lead', 'scrum'],
  lead: ['developer', 'principal', 'scrum'],
};

/** Which roles may report to a member holding a given role — orthogonal to
 * ASSIGNABLE_ROLES above. That table answers "what may *I* grant"; this one
 * answers "what may legally live *here*", regardless of who is doing the
 * adding. A principal heads a discipline, not a sub-org, so only developers
 * may sit beneath one; a developer manages nobody at all. Both checks run on
 * every create, re-parent, and role change (see
 * OrgStore._validateMemberFields) — the UI only mirrors this to avoid
 * offering a choice the server would reject. */
const ROLES_ALLOWED_UNDER = {
  lead: ['developer', 'lead', 'principal', 'scrum'],
  principal: ['developer'],
  // A scrum runs ceremonies for a team, not a reporting line — nobody sits
  // beneath one. Read the table the other way and it is the rule as stated:
  // a lead reports only to a lead, a principal and a scrum only to a lead,
  // and a developer to a lead or a principal.
  scrum: [],
  developer: [],
};

/** The roles that may report to `parentRole`. Unknown roles get [] rather
 * than everything, so a future role fails closed. */
function rolesAllowedUnder(parentRole) {
  return (ROLES_ALLOWED_UNDER[parentRole] || []).slice();
}

/** Seniority, used only to classify a role *change* (see roleChangeKind).
 * `scrum` shares a rank with `developer` because it is a separate track
 * rather than a step on the same ladder. Note that no change into or out of
 * `scrum` is legal at all (see crossesScrumTrack), so scrum's rank here is
 * only ever consulted for changes that are already refused — it is kept
 * ranked rather than removed so the table stays total over VALID_ROLES. */
const ROLE_RANK = {
  developer: 1,
  scrum: 1,
  principal: 2,
  lead: 3,
};

/** True when a role change crosses the boundary of the `scrum` track in
 * EITHER direction — developer/principal/lead -> scrum, or scrum -> any of
 * them.
 *
 * The scrum is not a rung on the delivery ladder: they run ceremonies for a
 * team rather than carrying its work, so "promoting a developer to scrum" or
 * "demoting the scrum to developer" are not changes of seniority, they are
 * changes of what the person does. Converting a row in place would silently
 * carry the whole membership across — the reporting line beneath them, the
 * parent above them, and (for a scrum) a roster exemption the Team page
 * relies on (see rosterFor). Both directions are therefore refused outright
 * and the person is removed and re-added instead, which forces every one of
 * those edges to be restated deliberately.
 *
 * Only the direction matters, not the rank, which is why this is separate
 * from roleChangeKind. A no-op (`from === to`) is not a change. */
function crossesScrumTrack(from, to) {
  if (from === to) return false;
  return from === 'scrum' || to === 'scrum';
}

/** Classifies a role change so callers can apply the one asymmetric rule in
 * this chart: moving *up* is always fine, moving *down* is only fine when the
 * person has nobody reporting to them (otherwise their reports would be left
 * under someone who may not have any — see OrgStore._validateMemberFields,
 * which offers to re-parent them instead of refusing outright). An unknown
 * role ranks 0, which makes any change involving it a demotion — failing
 * closed, consistent with rolesAllowedUnder. */
function roleChangeKind(from, to) {
  const before = ROLE_RANK[from] || 0;
  const after = ROLE_RANK[to] || 0;
  if (after > before) return 'promotion';
  if (after < before) return 'demotion';
  return 'lateral';
}

/** The owner always sees the Team page, even before their org-chart row
 * exists — that row is only created the first time they open "Manage team",
 * which lives on the Team page itself, so gating on `role` alone would leave
 * the owner unable to ever reach the button that creates it. */
function canSeeTeamPage(role, isOwner) {
  return !!isOwner || (!!role && ROLE_CAPABILITIES[role] && ROLE_CAPABILITIES[role].has('teamPage'));
}

/** Everyone except a `scrum` account can see Pull Requests — including
 * someone with no role at all (an ordinary developer not in the chart). */
function canSeePullRequests(role) {
  return role !== 'scrum';
}

/** Manage-team access: the dashboard owner (see sync.isOwner) or anyone whose
 * role carries the `adminOrg` capability — each scoped to their own subtree
 * by the caller (see server/index.js). */
function canAdminOrg(role, isOwner) {
  return !!isOwner || (!!role && ROLE_CAPABILITIES[role] && ROLE_CAPABILITIES[role].has('adminOrg'));
}

/** The roles `role` (or the owner, if `isOwner`) may create/assign to
 * someone else. Returns a fresh array — callers may treat it as immutable. */
function assignableRoles(role, isOwner) {
  if (isOwner) return ASSIGNABLE_ROLES.owner.slice();
  return (role && ASSIGNABLE_ROLES[role] ? ASSIGNABLE_ROLES[role] : []).slice();
}

/** True if `role` (or the owner) may assign `targetRole` to a member. */
function canAssignRole(role, isOwner, targetRole) {
  return assignableRoles(role, isOwner).includes(targetRole);
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function genId(prefix) {
  return `${prefix}_${require('crypto').randomBytes(5).toString('hex')}`;
}

/** Coerces/validates a raw parsed JSON blob into the canonical store shape.
 * One bad team or member is dropped rather than failing the whole store. A
 * missing `id` is generated rather than dropping the entry, so a person can
 * hand-author (or hand-edit) the JSON block on the wiki page without having
 * to invent ids themselves — the app fills them in and writes them back on
 * its next save. */
function normalizeStore(raw) {
  const teams = [];
  const teamIds = new Set();
  for (const t of Array.isArray(raw && raw.teams) ? raw.teams : []) {
    if (!t || typeof t.name !== 'string' || !t.name.trim()) continue;
    const id = typeof t.id === 'string' && t.id ? t.id : genId('t');
    if (teamIds.has(id)) continue;
    teamIds.add(id);
    const managerMemberId = typeof t.managerMemberId === 'string' ? t.managerMemberId : null;
    teams.push({ id, name: t.name.trim(), managerMemberId });
  }

  const members = [];
  const memberIds = new Set();
  // Uniqueness is (email, teamId), not email — one row per membership, so the
  // same person can appear once per team they belong to. A second row for the
  // SAME team is still a duplicate and is dropped.
  const seenMemberships = new Set();
  for (const m of Array.isArray(raw && raw.members) ? raw.members : []) {
    if (!m) continue;
    const email = normalizeEmail(m.email);
    if (!email || !email.includes('@')) continue;
    const id = typeof m.id === 'string' && m.id ? m.id : genId('m');
    const teamId = typeof m.teamId === 'string' && teamIds.has(m.teamId) ? m.teamId : null;
    const membership = `${email} ${teamId || ''}`;
    if (memberIds.has(id) || seenMemberships.has(membership)) continue;
    const role = typeof m.role === 'string' ? m.role.trim().toLowerCase() : '';
    if (!VALID_ROLES.has(role)) continue;
    const displayName = typeof m.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : email;
    const parentId = typeof m.parentId === 'string' ? m.parentId : null;
    memberIds.add(id);
    seenMemberships.add(membership);
    members.push({ id, email, displayName, role, teamId, parentId });
  }
  // Drop a parentId pointing at a member that didn't survive normalization.
  for (const m of members) {
    if (m.parentId && !memberIds.has(m.parentId)) m.parentId = null;
  }
  // Same fix-up for a team's managerMemberId.
  for (const t of teams) {
    if (t.managerMemberId && !memberIds.has(t.managerMemberId)) t.managerMemberId = null;
  }

  // The Scrum page's blocked convention (US5) rides along on the same wiki
  // page/ETag as the org chart — it is per-project configuration, and this
  // store is already the per-project, wiki-backed home for that (see
  // server/blockedConvention.js). Shape validation against the project's
  // real states/tags/fields happens at write time, not here; a malformed
  // blob is simply dropped rather than failing the whole store load.
  const blockedConvention =
    raw && raw.blockedConvention && raw.blockedConvention.version === 1 && typeof raw.blockedConvention.byType === 'object'
      ? raw.blockedConvention
      : null;

  return {
    version: 1,
    updatedAt: typeof (raw && raw.updatedAt) === 'string' ? raw.updatedAt : new Date().toISOString(),
    teams,
    members,
    blockedConvention,
  };
}

function findMember(store, id) {
  return store.members.find((m) => m.id === id) || null;
}

/** Every membership row belonging to one person. */
function findMembersByEmail(store, email) {
  const target = normalizeEmail(email);
  return store.members.filter((m) => m.email === target);
}

/** One person's PRIMARY row — the one that stands for them when a single row
 * is needed (their identity on this screen, the row nobody may delete). A row
 * with no team wins: that is the owner's root, or someone who heads teams
 * rather than belonging to one. Otherwise the most senior membership, so a
 * person who leads one team and develops in another is represented by the
 * lead row. Use findMembersByEmail when the question is about the person
 * across all their teams. */
function findMemberByEmail(store, email) {
  const rows = findMembersByEmail(store, email);
  if (rows.length === 0) return null;
  return rows.slice().sort((a, b) => {
    if (!a.teamId !== !b.teamId) return a.teamId ? 1 : -1;
    return (ROLE_RANK[b.role] || 0) - (ROLE_RANK[a.role] || 0);
  })[0];
}

function findTeam(store, id) {
  return store.teams.find((t) => t.id === id) || null;
}

function childrenOf(store, memberId) {
  return store.members.filter((m) => m.parentId === memberId);
}

/** Every id reachable by following `parentId` downward from `memberId`,
 * regardless of role — used for cycle prevention and admin subtree scoping
 * (both need "all descendants", not just the role-filtered roster). A
 * `visited` guard makes this safe even if a cycle already exists in stored
 * data (the parent field is user-editable). */
function descendantIds(store, memberId) {
  const result = new Set();
  const queue = [memberId];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const child of childrenOf(store, current)) {
      if (result.has(child.id)) continue;
      result.add(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

/** True if setting `memberId`'s parent to `newParentId` would create a cycle
 * — i.e. `newParentId` is `memberId` itself or already one of its
 * descendants. */
function wouldCycle(store, memberId, newParentId) {
  if (!newParentId) return false;
  if (newParentId === memberId) return true;
  return descendantIds(store, memberId).has(newParentId);
}

/** Reading order for a roster: seniority descending, with the scrum sitting
 * directly under the lead they serve. Deliberately not ROLE_RANK, which
 * classifies a role *change* and puts scrum level with developer. */
const ROLE_DISPLAY_ORDER = { lead: 0, scrum: 1, principal: 2, developer: 3 };

function byRoleThenName(a, b) {
  const rank = (ROLE_DISPLAY_ORDER[a.role] ?? 9) - (ROLE_DISPLAY_ORDER[b.role] ?? 9);
  return rank !== 0 ? rank : a.displayName.localeCompare(b.displayName);
}

/** Every team `memberId` heads. A lead may head any number of them. */
function teamsManagedBy(store, memberId) {
  return store.teams.filter((t) => t.managerMemberId === memberId);
}

/** One team's roster: exactly the members carrying that `teamId`, ordered by
 * walking `parentId` down from the team's manager so the flat list matches
 * the tree. The manager is not included (they head the team rather than
 * belonging to it, and may head several).
 *
 * Membership comes from `teamId` alone — this is the fix for one manager's
 * teams all showing the same people. A member whose `parentId` points
 * outside the team is still returned, appended after the ordered walk, so a
 * hand-edited wiki page can never make someone silently vanish from the
 * only screen that could repair them. */
function teamRosterFor(store, teamId) {
  const team = findTeam(store, teamId);
  if (!team) return [];
  // Seniority order within every level — lead, scrum, principal, then
  // developers — matching what the Manage Teams tree and list render
  // (byRoleThenName in web/src/features/team/manage/roleRules.ts).
  const inTeam = store.members.filter((m) => m.teamId === teamId).sort(byRoleThenName);
  const byId = new Map(inTeam.map((m) => [m.id, m]));
  const ordered = [];
  const seen = new Set();

  const visit = (parentId) => {
    for (const member of inTeam) {
      if (member.parentId !== parentId || seen.has(member.id)) continue;
      seen.add(member.id);
      ordered.push(member);
      visit(member.id);
    }
  };
  visit(team.managerMemberId);

  // Anyone the walk couldn't reach — their parent is missing, outside this
  // team, or cyclic. Surfaced rather than dropped.
  for (const member of inTeam) {
    if (!seen.has(member.id) && byId.has(member.id)) ordered.push(member);
  }
  return ordered;
}

/** What a `scrum` sees on the Team page: the same people their own team lead
 * does, and nobody else. A scrum runs ceremonies for one team — they manage
 * no one and nobody reports to them, so deriving their roster from the
 * reporting line (as every other role's is) would leave it empty. It comes
 * from their membership instead: their team's roster plus the lead who heads
 * it. Strictly that one team — a scrum added to one team never sees another,
 * even one the same lead heads. */
function scrumRosterFor(store, self) {
  if (!self.teamId) return [];
  const team = findTeam(store, self.teamId);
  if (!team) return [];
  const manager = team.managerMemberId ? findMember(store, team.managerMemberId) : null;
  const roster = manager ? [manager, ...teamRosterFor(store, team.id)] : teamRosterFor(store, team.id);
  // `role !== 'scrum'` also covers `self` — see rosterFor for why a scrum is
  // never a roster entry, here applied to the co-scrum case as well.
  return roster.filter((m) => m.id !== self.id && m.role !== 'scrum');
}

/** The roster a lead/principal/scrum member sees on the Team page: everyone
 * in every team they manage, plus their own direct `parentId` reports (which
 * covers a principal's developers inside someone else's team). A
 * `principal` only ever sees their own direct reports, never expanded
 * further, matching the Team page's framing for that role; a `scrum` sees
 * their whole team (see scrumRosterFor). Never includes `memberId` itself. */
function rosterFor(store, memberId) {
  const self = findMember(store, memberId);
  if (self && self.role === 'scrum') return scrumRosterFor(store, self);
  const expandDescendants = !self || self.role !== 'principal';
  const roster = [];
  const visited = new Set([memberId]);

  const queue = childrenOf(store, memberId);
  if (expandDescendants) {
    for (const team of teamsManagedBy(store, memberId)) {
      queue.push(...teamRosterFor(store, team.id));
    }
  }

  while (queue.length > 0) {
    const member = queue.shift();
    if (visited.has(member.id)) continue;
    visited.add(member.id);
    roster.push(member);
    if (expandDescendants && (member.role === 'lead' || member.role === 'principal')) {
      queue.push(...childrenOf(store, member.id));
    }
  }
  // The scrum is deliberately not someone you follow. They run ceremonies
  // rather than carrying a delivery workload of their own, so a scrum row
  // on the Team page is an empty dashboard taking up a slot in the picker.
  // Excluded here, at the one function every "who can I follow" surface
  // funnels through (rolesMapFrom's `team`, and rosterGroupsFor's fallback
  // group), so the roster, the picker and the view permission it grants all
  // agree. They remain fully visible and editable in Manage Teams, which
  // reads the raw store rather than a roster — the chart still has to be
  // able to show and repair them.
  return roster.filter((m) => m.role !== 'scrum');
}

/** How much a role lets you do, used only to collapse several memberships
 * into the single `role` the rest of the app asks for. Ordered by breadth of
 * access: a developer sees least, a lead most.
 *
 * KNOWN EDGE: someone who is a developer in one team and the scrum of
 * another resolves to `scrum`, which does not see Pull Requests. That is the
 * conservative reading — a scrum account is deliberately narrowed — but it is
 * a real capability loss for a person who is genuinely also a developer. It
 * cannot happen until somebody holds both of those roles at once. */
const CAPABILITY_ORDER = { developer: 0, scrum: 1, principal: 2, lead: 3 };

/** Builds the `Map<email, {role, team: string[]}>` shape every downstream
 * consumer expects (SyncEngine.getRoleEntryFor, getTeamMembersFor, the whole
 * /api/team path).
 *
 * Keyed by PERSON, while the store is keyed by membership — so someone in
 * three teams contributes three rows to one entry: their role is the widest
 * of the three, and their roster is the union, deduplicated. Without the
 * fold, whichever row happened to come last in the file silently decided
 * both. */
function rolesMapFrom(store) {
  const roles = new Map();
  for (const member of store.members) {
    const existing = roles.get(member.email);
    const emails = new Set(existing ? existing.team : []);
    for (const m of rosterFor(store, member.id)) {
      if (m.email !== member.email) emails.add(m.email);
    }
    const role =
      existing && (CAPABILITY_ORDER[existing.role] || 0) >= (CAPABILITY_ORDER[member.role] || 0) ? existing.role : member.role;
    roles.set(member.email, { role, team: [...emails] });
  }
  return roles;
}

/** Splits `rosterFor(store, memberId)` into named groups so the Team page
 * can offer "pick a whole team" alongside individual people, with no one
 * appearing in two groups.
 *
 * Groups are keyed by TEAM, not by direct report — that is what keeps a lead
 * who heads three teams from seeing one undifferentiated blob (previously
 * every group was a direct child, so three teams sharing a manager collapsed
 * together). Anyone in the roster who belongs to none of those teams falls
 * into a single `'direct'` group. Returns `[]` for a `principal`, whose
 * roster is already just their direct reports with nothing left to group. */
function rosterGroupsFor(store, memberId) {
  const self = findMember(store, memberId);
  if (self && self.role === 'principal') return [];

  // A scrum's roster is exactly one team, so it gets exactly one group,
  // named after that team rather than "Reports to me" — nobody reports to a
  // scrum, and the team name is what the group actually is.
  if (self && self.role === 'scrum') {
    const roster = scrumRosterFor(store, self);
    if (roster.length === 0) return [];
    const team = findTeam(store, self.teamId);
    return [{ id: self.teamId, label: team ? team.name : 'My team', emails: roster.map((m) => m.email) }];
  }

  const groups = [];
  const grouped = new Set();

  for (const team of teamsManagedBy(store, memberId)) {
    // Same scrum exclusion rosterFor applies — without it a team group would
    // offer someone the flat roster doesn't, and the two counts would drift.
    const roster = teamRosterFor(store, team.id).filter((m) => m.role !== 'scrum');
    if (roster.length === 0) continue;
    for (const member of roster) grouped.add(member.id);
    groups.push({ id: team.id, label: team.name, emails: roster.map((m) => m.email) });
  }

  const direct = rosterFor(store, memberId)
    .filter((m) => !grouped.has(m.id))
    .map((m) => m.email);
  if (direct.length > 0) {
    groups.push({ id: 'direct', label: 'Reports to me', emails: direct });
  }
  return groups;
}

/** rosterGroupsFor, but keyed by PERSON rather than by one membership row —
 * the same fold rolesMapFrom does, and it has to be the same or the Team
 * page contradicts itself.
 *
 * Since one person can hold several memberships, a lead of team A who also
 * sits in team B has two rows. The members list comes from rolesMapFrom,
 * which unions the rosters of ALL their rows; the groups used to come from
 * `findMemberByEmail`'s single PRIMARY row. Anyone reachable only through a
 * secondary row therefore landed in the members list but in no group — and
 * because the picker renders groups while the badge counted members, they
 * were invisible ghosts that made "Show members (2)" appear with nothing
 * ticked and no way to untick it. Unioning here is what keeps every member
 * the page counts also selectable in the menu. Groups are deduped by team
 * id, since two rows in the same team produce the same group. */
function rosterGroupsForEmail(store, email) {
  const rows = findMembersByEmail(store, email);
  const byId = new Map();
  for (const row of rows) {
    for (const group of rosterGroupsFor(store, row.id)) {
      const existing = byId.get(group.id);
      if (!existing) {
        byId.set(group.id, { ...group, emails: [...group.emails] });
        continue;
      }
      // Same team seen from two rows (or the shared 'direct' bucket) — merge
      // rather than let the first one win and drop the rest.
      for (const e of group.emails) if (!existing.emails.includes(e)) existing.emails.push(e);
    }
  }
  // Someone already named by a real team group must not also appear in the
  // catch-all: rosterGroupsFor only dedupes within a single row's groups, so
  // across rows the same person can reach both.
  const namedTeamEmails = new Set();
  for (const [id, group] of byId) {
    if (id !== 'direct') for (const e of group.emails) namedTeamEmails.add(e);
  }
  const direct = byId.get('direct');
  if (direct) {
    direct.emails = direct.emails.filter((e) => !namedTeamEmails.has(e));
    if (direct.emails.length === 0) byId.delete('direct');
  }
  return [...byId.values()];
}

const WIKI_JSON_FENCE = /```json\s*([\s\S]*?)```/i;

/** The wiki page body this store round-trips through — a short human note
 * plus the store as a fenced JSON block. The note warns against hand-editing
 * while the app is running: a concurrent
 * save would win via the ETag check and silently discard a hand edit that
 * raced it. */
function renderOrgMarkdown(store) {
  const json = JSON.stringify(
    { version: store.version, teams: store.teams, members: store.members, blockedConvention: store.blockedConvention || null },
    null,
    2
  );
  return (
    '# Dashboard Org Chart\n\n' +
    'Managed by the Team page\'s "Manage team" screen — this page is the durable copy (the app also ' +
    'keeps a local cache, which is lost on hosts with no persistent disk). You can hand-edit the JSON ' +
    'block below directly; ids may be omitted for new entries and will be filled in automatically. ' +
    "Avoid editing at the same moment as someone is using Manage Team — whichever save lands last wins.\n\n" +
    '```json\n' +
    json +
    '\n```\n'
  );
}

/** Parses the store back out of renderOrgMarkdown's fenced block. Returns
 * null (not an empty store) when the page has no fenced JSON at all or the
 * JSON doesn't parse — callers should treat null as "nothing usable here"
 * and fall back to their own default, rather than treating unparsable
 * content the same as a deliberately empty chart. */
function parseOrgMarkdown(markdown) {
  if (typeof markdown !== 'string') return null;
  const match = markdown.match(WIKI_JSON_FENCE);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

module.exports = {
  VALID_ROLES,
  canSeeTeamPage,
  canSeePullRequests,
  canAdminOrg,
  assignableRoles,
  canAssignRole,
  rolesAllowedUnder,
  roleChangeKind,
  crossesScrumTrack,
  renderOrgMarkdown,
  parseOrgMarkdown,
  normalizeEmail,
  genId,
  normalizeStore,
  findMember,
  findMemberByEmail,
  findMembersByEmail,
  findTeam,
  childrenOf,
  descendantIds,
  wouldCycle,
  rosterFor,
  scrumRosterFor,
  teamsManagedBy,
  teamRosterFor,
  rosterGroupsFor,
  rosterGroupsForEmail,
  rolesMapFrom,
};
