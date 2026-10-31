const fs = require('fs');
const path = require('path');
const { fetchWikiPageWithMeta, putWikiPage, wikiExists } = require('./ado/wiki');
const { ValidationError, ForbiddenError } = require('./ado/writeback');
const {
  VALID_ROLES,
  normalizeEmail,
  genId,
  normalizeStore,
  renderOrgMarkdown,
  parseOrgMarkdown,
  findMember,
  findMemberByEmail,
  findMembersByEmail,
  findTeam,
  descendantIds,
  wouldCycle,
  rolesAllowedUnder,
  roleChangeKind,
  crossesScrumTrack,
  childrenOf,
} = require('./org');

/** A ValidationError carrying a machine-readable `code` instead of the
 * default 'VALIDATION'. The routes already pass `err.code` through in the
 * JSON body, so the Manage Teams UI can recognise these two specific
 * refusals and offer a confirmation step rather than a dead end. Everything
 * the user needs to read is in `message` — the code only decides whether a
 * confirm button appears. Optional `details` carries structured data (counts,
 * names) for the client to compose localized error messages. */
function codedValidationError(message, code, details = null) {
  const err = new ValidationError(message);
  err.code = code;
  if (details) err.details = details;
  return err;
}

function emptyStore() {
  return { version: 1, updatedAt: new Date().toISOString(), teams: [], members: [], blockedConvention: null };
}

/**
 * Org chart store — see server/org.js for the shape and the pure logic over
 * it. The durable copy lives on the "Dashboard Roles" wiki page (a fenced
 * JSON block, see renderOrgMarkdown/parseOrgMarkdown), because this app also
 * runs on hosts with no persistent disk (Render's free tier): a local file
 * alone would be silently wiped on every redeploy/restart there. `filePath`
 * is kept as a best-effort local cache only — write failures there are
 * logged and swallowed, never allowed to block a save, and a read failure
 * just falls through to the wiki. The wiki write, by contrast, is the one
 * that must succeed for a mutation to be considered saved: if it fails
 * (network blip, or the PAT lacks Wiki Read & Write), the API call fails
 * loudly rather than reporting success on data that will vanish on restart.
 *
 * Single process, single writer against the local cache, so an in-memory
 * copy plus a write-through save is enough there — no locking needed. The
 * wiki page itself is guarded by its ETag (If-Match), so a concurrent edit
 * from the ADO web UI, or a second instance of this app, surfaces as a 409
 * instead of one write silently clobbering the other.
 */
class OrgStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.store = null;
    this.client = null;
    this.wikiName = null;
    this.wikiPage = null;
    this.eTag = null;
    // False once a read of this project's wiki has failed outright (no
    // `<project>.wiki` exists, or the token can't read it) — as opposed to
    // succeeding and finding no page yet, which is a legitimate "nothing set
    // up here" state. Surfaced to the client so an empty Team page can say
    // which of the two it is. Null until the first read.
    this.wikiAvailable = null;
  }

  /** Loads the chart, preferring the wiki (the durable copy) and falling
   * back to the local cache file only if the wiki can't be reached at all
   * (e.g. offline dev) — never on a successful read that's simply empty,
   * which is a legitimate "nothing here yet" state, not a failure. */
  async load(client, config) {
    if (this.store) return this.store;
    this.client = client;
    this.wikiName = config.rolesWikiName;
    this.wikiPage = config.rolesWikiPage;
    return this._readThrough();
  }

  /** Drops the in-memory copy and reads the wiki again, refreshing both the
   * chart and the ETag guarding the next write.
   *
   * Both matter. The wiki page is hand-editable in ADO, and this process used
   * to read it exactly once per restart: after an outside edit the app kept
   * serving a stale chart (deleted people still listed), and — worse — kept a
   * stale ETag, so every subsequent save failed the If-Match check with a raw
   * "has been updated by another client" error and stayed wedged until the
   * process was restarted. */
  async reload() {
    if (!this.client) return this.getStore();
    this.store = null;
    this.eTag = null;
    return this._readThrough({ priority: true });
  }

  async _readThrough({ priority = false } = {}) {
    try {
      const { content, eTag } = await fetchWikiPageWithMeta(this.client, this.wikiName, this.wikiPage, { priority });
      this.eTag = eTag;
      // A null page reads the same whether the page simply hasn't been created
      // yet or the project has no wiki at all — only the second is a problem,
      // and it's worth one extra request to know which it is.
      this.wikiAvailable = content === null ? await wikiExists(this.client, this.wikiName) : true;
      const parsed = parseOrgMarkdown(content);
      this.store = normalizeStore(parsed || {});
      this._saveLocalCache();
      return this.store;
    } catch (err) {
      this.wikiAvailable = false;
      // eslint-disable-next-line no-console
      console.error(`[org] could not read ${this.wikiName} — falling back to the local cache:`, err.message);
    }

    if (fs.existsSync(this.filePath)) {
      try {
        this.store = normalizeStore(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
        return this.store;
      } catch (err) {
        // Corrupt file — fall through to a fresh (empty) store.
      }
    }
    this.store = emptyStore();
    return this.store;
  }

  /** Every mutation ends here. The wiki write is required — its failure
   * propagates so the caller's API response reflects that nothing durable
   * actually happened. The local cache write is best-effort and never
   * throws, since losing it just means one fewer fallback, not lost data.
   *
   * A rejected If-Match (ADO answers 412; 409 is accepted too) means the page
   * moved under us — someone edited it in the ADO web UI, or another instance
   * saved first. That used to escape as a raw ADO error and, because the
   * stale ETag was kept, wedged every later write as well. Now the chart is
   * re-read (restoring both the true content and a usable ETag) and the
   * caller gets a plain message telling them to look and try again. The
   * unsaved in-memory edit is deliberately discarded rather than replayed:
   * it was composed against data that no longer exists, and replaying it
   * would silently overwrite whatever the other editor just did. */
  async _save() {
    this.store.updatedAt = new Date().toISOString();
    this._saveLocalCache();
    const markdown = renderOrgMarkdown(this.store);
    try {
      this.eTag = await putWikiPage(this.client, this.wikiName, this.wikiPage, markdown, this.eTag, { priority: true });
    } catch (err) {
      if (err.status === 412 || err.status === 409) {
        await this.reload();
        throw codedValidationError(
          'The org chart was changed somewhere else (the wiki page, or another tab) — it has been reloaded here. Check it and make your change again.',
          'CONFLICT'
        );
      }
      if (err.status === 404) {
        // A 404 on the page write has two quite different causes, and claiming
        // the wrong one sends someone off to create a wiki that already exists.
        // So ask: does the wiki itself exist?
        //
        //  - No  -> the project genuinely has no wiki. Without this branch the
        //           raw ADO error escaped as a 502 "ADO_ERROR", which reads as a
        //           dashboard fault rather than the one-time project setup it is.
        //  - Yes -> the wiki is fine and the PAGE PATH is what ADO couldn't
        //           resolve (a misconfigured ADO_ROLES_WIKI_PAGE, or a parent
        //           path that doesn't exist). Verified the hard way: a mangled
        //           page path produced this exact 404 and got reported as
        //           "this project has no wiki", which was simply false.
        const exists = await wikiExists(this.client, this.wikiName);
        this.wikiAvailable = exists;
        if (!exists) {
          throw codedValidationError(
            `This project has no wiki named “${this.wikiName}” yet, so the org chart can't be saved. ` +
              'Create a project wiki in Azure DevOps (Overview → Wiki), then try again.',
            'WIKI_MISSING'
          );
        }
        throw codedValidationError(
          `Azure DevOps couldn't resolve the page “${this.wikiPage}” in “${this.wikiName}”, so the org chart ` +
            "can't be saved. Check ADO_ROLES_WIKI_PAGE — it must be a page path starting with “/”, and any " +
            'parent page in it has to exist already.',
          'WIKI_PAGE_INVALID'
        );
      }
      throw err;
    }
  }

  _saveLocalCache() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[org] local cache write failed (non-fatal — the wiki write is what matters):', err.message);
    }
  }

  /** In-memory snapshot — used by SyncEngine.ensureRoles, which must stay
   * synchronous-in-spirit (no awaiting a network read on every role check). */
  getStore() {
    return this.store || emptyStore();
  }

  /** Creates the caller's own root member row the first time the owner
   * opens Manage Team on a fresh (or ownerless) chart — otherwise there is
   * no root to build downward from. Nobody but the owner is auto-created; a
   * Lead with no row simply has an empty subtree. Role is `lead` (not
   * `principal`) because the owner has full adminOrg rights over the whole
   * chart, and a `principal` row would be view-only. */
  async ensureOwnerMember(email, displayName) {
    const normalized = normalizeEmail(email);
    let member = findMemberByEmail(this.store, normalized);
    if (member) return member;
    member = { id: genId('m'), email: normalized, displayName: displayName || normalized, role: 'lead', teamId: null, parentId: null };
    this.store.members.push(member);
    await this._save();
    return member;
  }

  /** US5's only write: saves a validated BlockedConvention alongside the org
   * chart on the same wiki page, guarded by the same ETag — a concurrent
   * edit (from the ADO web UI, Manage Team, or another instance) surfaces as
   * the same 409 the org chart already produces (FR-035c-i). The caller
   * (server/index.js) validates against the project's real states/tags/
   * fields BEFORE calling this — this method persists, it doesn't validate. */
  async saveBlockedConvention(convention) {
    const store = this.store;
    const previous = store.blockedConvention;
    store.blockedConvention = convention;
    try {
      await this._save();
    } catch (err) {
      // Roll back the in-memory mutation on a failed persist — otherwise a
      // WIKI_MISSING/WIKI_PAGE_INVALID (or any other non-conflict) failure
      // leaves an unsaved convention live in memory, answered back by every
      // later read as if it had been saved. The 409/412 branch inside
      // _save() is the one exception: it already calls reload(), which
      // replaces `this.store` outright with freshly-read data — in that
      // case `this.store` is no longer `store`, so there is nothing of
      // ours left to roll back (rolling back would stomp the reload).
      if (this.store === store) store.blockedConvention = previous;
      throw err;
    }
    // Return the value THIS call wrote, not a fresh read of the (shared,
    // mutable) store — under two concurrent saves, re-reading here could
    // hand call A back call B's value even though A's own write is what
    // actually reached the wiki, since both mutate the same store object.
    return convention;
  }

  // --- Teams -------------------------------------------------------------

  /** Every team must name a manager, explicitly, and that manager must be a
   * `lead`. There is deliberately no default and no "no manager" state: the
   * manager is the root of the team's reporting line, so a team without one
   * has no coherent roster. It used to default to the creator, which quietly
   * made the dashboard owner the lead of every team they created — owner and
   * team lead are separate things.
   *
   * The role requirement follows from the reporting matrix: a team's members
   * hang off its manager, and only a `lead` may have a lead, principal or
   * scrum beneath them. A principal or scrum at the head of a team could only
   * ever hold developers, which is not a team — it is a discipline. */
  _assertValidManager(managerMemberId) {
    if (managerMemberId == null || managerMemberId === '') {
      throw new ValidationError('Pick a manager for this team.');
    }
    const manager = findMember(this.store, managerMemberId);
    if (!manager) throw new ValidationError('Unknown team manager.');
    if (manager.role !== 'lead') {
      throw new ValidationError(`Only a team lead can manage a team — ${manager.displayName} is a ${manager.role}.`);
    }
    return manager;
  }

  async createTeam({ name, managerMemberId }) {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed) throw new ValidationError('Team name is required.');
    this._assertValidManager(managerMemberId);
    const team = { id: genId('t'), name: trimmed, managerMemberId };
    this.store.teams.push(team);
    await this._save();
    return team;
  }

  async updateTeam(id, { name, managerMemberId }) {
    const team = this.store.teams.find((t) => t.id === id);
    if (!team) throw new ValidationError('Team not found.');
    if (name !== undefined) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) throw new ValidationError('Team name is required.');
      team.name = trimmed;
    }
    if (managerMemberId !== undefined) {
      // No null path: clearing a team's manager is not a supported state.
      this._assertValidManager(managerMemberId);
      if (managerMemberId !== team.managerMemberId) {
        const oldManagerId = team.managerMemberId;
        const newManager = findMember(this.store, managerMemberId);
        // A member promoted from within this same team keeps a stale
        // membership on it — teamId still pointing at the team they now
        // head instead of belong to, and parentId still pointing at
        // whoever they reported to within it (often the very lead they
        // are replacing). Left in place, they would show up twice in
        // their own roster (see teamRosterFor's "couldn't reach" bucket)
        // and the outgoing lead would still nominally hold management
        // rights over them (see assertInSubtree). A lead promoted in
        // from elsewhere already satisfies teamId: null (see the module
        // doc) and may legitimately still report to someone outside this
        // team, so only the within-team promotion case is cleared.
        if (newManager && newManager.teamId === team.id) {
          newManager.teamId = null;
          newManager.parentId = null;
        }
        // Everyone who reported directly to the outgoing manager within
        // this team would otherwise point at a parentId no longer at the
        // top of it — hand them to whoever now heads the team, the same
        // destination every other handover in this file uses (see
        // _reassignTargetFor, deleteTeam, deleteMember).
        if (oldManagerId) {
          for (const m of this.store.members) {
            if (m.teamId === team.id && m.parentId === oldManagerId && m.id !== managerMemberId) {
              m.parentId = managerMemberId;
            }
          }
        }
      }
      team.managerMemberId = managerMemberId;
    }
    await this._save();
    return team;
  }

  /** Deleting a team with people still on it removes them too — every member
   * belongs to exactly one team, so there is nowhere for them to land and no
   * "unassigned" state for them to land in. That is destructive enough to
   * require saying so out loud, so the populated case refuses by default and
   * reports how many people are at stake; `cascade` is the caller's answer
   * once they've confirmed. */
  async deleteTeam(id, { cascade = false } = {}) {
    const team = this.store.teams.find((t) => t.id === id);
    if (!team) throw new ValidationError('Team not found.');
    const roster = this.store.members.filter((m) => m.teamId === id);
    if (roster.length > 0 && !cascade) {
      throw codedValidationError(
        `“${team.name}” still has ${roster.length} ${roster.length === 1 ? 'member' : 'members'}. Deleting the team removes ${roster.length === 1 ? 'them' : 'them all'} from the org chart.`,
        'TEAM_NOT_EMPTY',
        { memberCount: roster.length }
      );
    }
    const removed = new Set(roster.map((m) => m.id));
    this.store.teams = this.store.teams.filter((t) => t.id !== id);
    this.store.members = this.store.members.filter((m) => !removed.has(m.id));
    // Anyone left pointing into the deleted set (a member of another team who
    // reported to one of these people) loses that parent rather than keeping
    // a dangling id — teamRosterFor surfaces a parentless member at the top
    // of their team, where they can be re-placed.
    for (const m of this.store.members) {
      if (m.parentId && removed.has(m.parentId)) m.parentId = null;
    }
    for (const t of this.store.teams) {
      if (t.managerMemberId && removed.has(t.managerMemberId)) t.managerMemberId = null;
    }
    await this._save();
  }

  // --- Members -------------------------------------------------------------

  /** Validates a member write shared by create/update. `memberId` is null on
   * create (nothing to cycle-check against yet); `existing` is the current
   * row on update, so a partial patch is judged against its merged result
   * rather than against whichever fields happened to be sent.
   *
   * Seven rules, all of which the UI mirrors but none of which it enforces:
   *
   *   1. `role` must be a known role.
   *   2. A regular member must belong to a team. The only rows allowed to
   *      sit outside one are the owner's root row and anyone who *manages* a
   *      team (a lead of three teams can't be expressed by one teamId).
   *   3. The parent must exist, must not be a `developer` (developers manage
   *      nobody), must not create a cycle, and must be legal for the child's
   *      role — see rolesAllowedUnder: only developers may report to a
   *      principal or scrum.
   *   4. The parent must be inside the member's own team — either that
   *      team's manager, or another member carrying the same teamId. This is
   *      what keeps `teamId` (membership) and `parentId` (reporting line)
   *      from drifting apart and producing rosters that disagree.
   *   5. A member who HEADS a team cannot have their role changed at all —
   *      the team is defined by them, and every other member's parent was
   *      validated against that role.
   *   6. A role may never change into or out of `scrum`, in either
   *      direction — see crossesScrumTrack. The scrum is a different job,
   *      not a rank, so the row is removed and re-added instead.
   *   7. A role change may go up or sideways freely, but only down when the
   *      member has nobody reporting to them — otherwise their reports would
   *      be stranded under someone who may not have any (a demoted lead's
   *      principals, say). Rather than refusing outright, this one is
   *      recoverable: `patch.reassignReports` re-parents them first, and the
   *      refusal says exactly where they would go.
   */
  _validateMemberFields(memberId, patch, existing = null) {
    const role = patch.role !== undefined ? patch.role : existing ? existing.role : undefined;
    const teamId = patch.teamId !== undefined ? patch.teamId : existing ? existing.teamId : null;
    const parentId = patch.parentId !== undefined ? patch.parentId : existing ? existing.parentId : null;

    if (role !== undefined && !VALID_ROLES.has(role)) {
      throw new ValidationError('Invalid role.');
    }
    if (teamId !== null && teamId !== undefined && !this.store.teams.some((t) => t.id === teamId)) {
      throw new ValidationError('Unknown team.');
    }

    // Someone may sit outside every team only if they head one, or if they
    // are a root of the chart (no parent) — the owner's row, and a newly
    // created team manager who has not been placed under anyone. Everyone
    // else, i.e. anyone who reports to somebody, needs a team.
    const managesATeam = memberId ? this.store.teams.some((t) => t.managerMemberId === memberId) : false;
    if (!teamId && parentId && !managesATeam) {
      throw new ValidationError('Pick a team for this person.');
    }

    if (parentId !== undefined && parentId !== null) {
      const parent = findMember(this.store, parentId);
      if (!parent) throw new ValidationError('Unknown parent.');
      if (parent.role === 'developer') throw new ValidationError('A developer cannot have reports.');
      if (memberId && wouldCycle(this.store, memberId, parentId)) {
        throw new ValidationError('That would create a reporting cycle.');
      }
      if (role !== undefined && !rolesAllowedUnder(parent.role).includes(role)) {
        const allowed = rolesAllowedUnder(parent.role);
        throw new ValidationError(
          allowed.length === 0
            ? `A ${parent.role} cannot have anyone reporting to them.`
            : `Only a ${allowed.join(' or ')} can report to a ${parent.role}.`
        );
      }
      if (teamId) {
        const team = findTeam(this.store, teamId);
        const parentHeadsThisTeam = team && team.managerMemberId === parentId;
        if (!parentHeadsThisTeam && parent.teamId !== teamId) {
          throw new ValidationError('That person reports to someone outside this team.');
        }
      }
    }

    // Rules 5 and 6 only concern a *change* of role on an existing member.
    if (!existing || patch.role === undefined || patch.role === existing.role) return;

    const headed = this.store.teams.find((t) => t.managerMemberId === memberId);
    if (headed) {
      throw new ValidationError(
        `${existing.displayName} heads “${headed.name}” — change that team’s manager before changing their role.`
      );
    }

    // A scrum is a separate track, not a rung on the same ladder as the
    // others (see crossesScrumTrack), so there is no such thing as promoting
    // into it or demoting out of it. BOTH directions are refused: a
    // developer, principal or lead cannot be converted into the scrum, and
    // the scrum cannot be converted into any of them. Either way the person
    // is removed and re-added in the role they actually hold, which forces
    // their team, manager and reporting line to be restated rather than
    // silently carried across a change that means something quite different.
    if (crossesScrumTrack(existing.role, patch.role)) {
      throw new ValidationError(
        existing.role === 'scrum'
          ? `${existing.displayName} is the scrum — remove them and add them again to give them a different role.`
          : `The scrum is a separate role, not a promotion — remove ${existing.displayName} and add them again as the scrum.`
      );
    }

    if (roleChangeKind(existing.role, patch.role) !== 'demotion') return;
    const reports = childrenOf(this.store, memberId);
    if (reports.length === 0 || patch.reassignReports === true) return;

    const newParent = this._reassignTargetFor(existing);
    const destination = newParent ? `to ${newParent.displayName}` : 'to the top of their team';
    throw codedValidationError(
      `${existing.displayName} has ${reports.length} ${reports.length === 1 ? 'person' : 'people'} reporting to them. ` +
        `Lowering their role moves ${reports.length === 1 ? 'that person' : 'them'} ${destination}.`,
      'REPORTS_REASSIGN_REQUIRED',
      { reportCount: reports.length, newManagerName: newParent?.displayName || null }
    );
  }

  /** Where a member's direct reports go when that member is demoted or
   * deleted: to the member's own manager — one level straight up, which is
   * always legal (only a lead or a principal can have reports at all, and a
   * principal's reports are developers, so moving up never lands anyone
   * under an illegal parent). A member with no manager of their own falls
   * back to their team's head, unless that is themselves. */
  _reassignTargetFor(member) {
    if (member.parentId) return findMember(this.store, member.parentId);
    const team = member.teamId ? findTeam(this.store, member.teamId) : null;
    if (team && team.managerMemberId && team.managerMemberId !== member.id) {
      return findMember(this.store, team.managerMemberId);
    }
    return null;
  }

  /** Creating a membership, not a person: the same email may already be in
   * the chart on OTHER teams, which is exactly how someone belongs to two at
   * once. Only a second row for the SAME team is a duplicate. */
  async createMember({ email, displayName, role, teamId, parentId }) {
    const normalized = normalizeEmail(email);
    if (!normalized || !normalized.includes('@')) throw new ValidationError('A valid email is required.');
    const here = findMembersByEmail(this.store, normalized).find((m) => (m.teamId ?? null) === (teamId ?? null));
    if (here) {
      const team = teamId ? findTeam(this.store, teamId) : null;
      throw new ValidationError(team ? `${here.displayName} is already on “${team.name}”.` : 'That person is already in the org chart.');
    }
    // Validate the role this member will actually get, not the possibly
    // undefined one that was sent — otherwise the default slips past the
    // parent-role matrix entirely.
    const effectiveRole = role || 'developer';
    this._validateMemberFields(null, { role: effectiveRole, teamId: teamId ?? null, parentId: parentId ?? null });
    const member = {
      id: genId('m'),
      email: normalized,
      displayName: (typeof displayName === 'string' && displayName.trim()) || normalized,
      role: effectiveRole,
      teamId: teamId ?? null,
      parentId: parentId ?? null,
    };
    this.store.members.push(member);
    await this._save();
    return member;
  }

  async updateMember(id, patch) {
    const member = findMember(this.store, id);
    if (!member) throw new ValidationError('Member not found.');
    this._validateMemberFields(id, patch, member);
    // Confirmed demotion (rule 6): move this member's reports up to their own
    // manager BEFORE lowering the role, so the chart is never even
    // transiently in the state the rule exists to prevent. `reassignReports`
    // is a control flag on the request, never a field on the member row.
    if (patch.reassignReports === true && patch.role !== undefined && roleChangeKind(member.role, patch.role) === 'demotion') {
      const target = this._reassignTargetFor(member);
      for (const child of this.store.members) {
        if (child.parentId === id) child.parentId = target ? target.id : null;
      }
    }

    // Leaving a team strands anyone who reported to them inside it: their
    // manager is now in a different team, which the same-team rule forbids
    // and teamRosterFor can only surface as an unplaced row. Hand them to
    // this member's own manager on the way out, the same destination a
    // demotion and a deletion use. Reports that follow to the new team are
    // deliberately not moved — a membership belongs to one team.
    if (patch.teamId !== undefined && (patch.teamId ?? null) !== (member.teamId ?? null)) {
      const target = this._reassignTargetFor(member);
      for (const child of this.store.members) {
        if (child.parentId === id && child.id !== id) child.parentId = target && target.id !== id ? target.id : null;
      }
    }
    if (patch.displayName !== undefined) {
      const trimmed = typeof patch.displayName === 'string' ? patch.displayName.trim() : '';
      member.displayName = trimmed || member.email;
    }
    if (patch.role !== undefined) member.role = patch.role;
    if (patch.teamId !== undefined) member.teamId = patch.teamId;
    if (patch.parentId !== undefined) member.parentId = patch.parentId;
    await this._save();
    return member;
  }

  /** Deletes a member and re-parents their children so nothing beneath them
   * is orphaned or silently dropped from the roster. They move to the
   * deleted member's own manager — the same destination a demotion uses (see
   * _reassignTargetFor), so "what happens to my reports" has one answer on
   * this screen rather than two. Deleting a principal therefore hands their
   * developers to whoever the principal reported to, which is the team lead
   * in the ordinary case anyway. */
  async deleteMember(id) {
    const member = findMember(this.store, id);
    if (!member) throw new ValidationError('Member not found.');
    const target = this._reassignTargetFor(member);
    const newParentId = target ? target.id : null;
    for (const child of this.store.members) {
      if (child.parentId === id) child.parentId = newParentId;
    }
    this.store.members = this.store.members.filter((m) => m.id !== id);
    await this._save();
  }

  // --- Scoping -------------------------------------------------------------

  /** The subset of the chart a caller may see/edit: their own row (if any)
   * plus every descendant. Applies uniformly to the owner and to a Lead —
   * the owner's root row has no ancestors, so its "subtree" is the whole
   * chart, with no separate code path required. Returns null when the
   * caller has no member row at all (an empty subtree). */
  subtreeFor(uniqueName) {
    const rows = findMembersByEmail(this.store, uniqueName);
    if (rows.length === 0) return { self: null, memberIds: new Set() };
    // Union across every team they belong to — a lead of one team who also
    // develops in another manages the first team's people from either row,
    // and `self` is the primary row that stands for them (see
    // findMemberByEmail). Their own other rows are part of the subtree too,
    // so they can edit their own membership elsewhere.
    const ids = new Set();
    for (const row of rows) {
      for (const id of descendantIds(this.store, row.id)) ids.add(id);
    }
    const self = findMemberByEmail(this.store, uniqueName);
    for (const row of rows) if (row.id !== self.id) ids.add(row.id);
    return { self, memberIds: ids };
  }

  /** Throws unless `targetId` is within the caller's own subtree — never
   * the caller's own row, which cannot edit or delete itself (that is what
   * stops a Lead promoting themselves). The dashboard owner is the one
   * exception: since they see and manage the whole chart, `targetId` only
   * needs to exist, and their own row IS a valid target (so the owner can,
   * e.g., join a team by setting their own `teamId`). */
  assertInSubtree(uniqueName, targetId, isOwner = false) {
    if (isOwner) {
      if (!findMember(this.store, targetId)) throw new ValidationError('Member not found.');
      return;
    }
    const { memberIds } = this.subtreeFor(uniqueName);
    if (!memberIds.has(targetId)) {
      throw new ForbiddenError('That person is outside your team.');
    }
  }

  /** A team is manageable by the owner, or by anyone whose subtree contains
   * its manager (including their own row) — a team with no manager can only
   * be managed by the owner. Throws rather than returning a boolean so every
   * call site fails closed. */
  assertCanManageTeam(uniqueName, teamId, isOwner) {
    if (isOwner) return;
    const team = findTeam(this.store, teamId);
    if (!team) throw new ValidationError('Team not found.');
    if (!team.managerMemberId) throw new ForbiddenError('That team is outside your team.');
    const { self, memberIds } = this.subtreeFor(uniqueName);
    const inScope = (self && team.managerMemberId === self.id) || memberIds.has(team.managerMemberId);
    if (!inScope) throw new ForbiddenError('That team is outside your team.');
  }
}

// codedValidationError is also exported for test/orgErrorDetails.test.js,
// which exercises this exact factory (not a copy of it) end to end through
// deleteTeam/updateMember and server/errorBody.js.
module.exports = { OrgStore, codedValidationError };
