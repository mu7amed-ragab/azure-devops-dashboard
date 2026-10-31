/**
 * 006-linked-identity-aliases.
 *
 * When an organization retires a sign-in domain (this deployment's own
 * `legacy-example.onmicrosoft.com` → `EXAMPLE.DEV` migration is the motivating case —
 * see the original design notes), a person acquires a SECOND
 * Azure DevOps identity. Work items can, with effort, be reassigned to the
 * new one; pull requests, their votes/comments, and commit authorship cannot
 * — they stay permanently stamped with whichever identity created them. This
 * module is what lets every READ in the app answer "everything this person
 * ever did", not just "everything this person's current account did",
 * without touching Azure DevOps at all.
 *
 * `IdentitySet` is deliberately NOT an alias table or a merge: `primary`
 * keeps meaning the identity that actually signed in, and every existing
 * consumer of `person.id` / `person.uniqueName` keeps reading the primary
 * unchanged. Only the reads that explicitly widen (see server/sync.js,
 * server/crossHours.js, server/scrum.js) ever look at `.all` / `.keys`. This
 * is what lets server/ado/writeback.js#assertAssignedTo stay completely
 * untouched — a linked identity confers READ visibility only (spec.md
 * FR-008); it is never an authorization subject.
 */

const { findIdentitiesByLocalPart, localPart } = require('./ado/identityPicker');

/** No configured cap invites a degenerate local part (a role account, a
 * generic name) into issuing dozens of PR searches per sign-in. A local part
 * that genuinely matches more than this many identities is a sign the
 * assumption behind FR-004 (usernames identify a person) doesn't hold for
 * it, not a reason to keep widening — the set is simply truncated, keeping
 * the primary and the first candidates found. */
const MAX_LINKED_IDENTITIES = 8;

/** True when `candidate` is eligible to link to `primary` under FR-004:
 * exact, case-insensitive local-part equality; never the same identity
 * (including the same address under different casing); a usable id. */
function isEligibleLink(primary, candidate) {
  if (!candidate || !candidate.uniqueName) return false;
  if (!candidate.id) return false;
  if (localPart(candidate.uniqueName) !== localPart(primary.uniqueName)) return false;
  if (candidate.id === primary.id) return false;
  if (candidate.uniqueName.toLowerCase() === primary.uniqueName.toLowerCase()) return false;
  return true;
}

/** Builds the `IdentitySet` for `primary` out of a flat list of candidate
 * identities (already gathered from whatever sources; see
 * `resolveIdentitySet` below for the real ones). Pure and synchronous so the
 * FR-004 matching rule is testable in isolation from any network access —
 * this is the function test/identitySet.test.js exercises directly. */
function buildIdentitySet(primary, candidates, { degraded = false } = {}) {
  const seen = new Map(); // lowercased uniqueName -> identity
  for (const candidate of candidates || []) {
    if (!isEligibleLink(primary, candidate)) continue;
    const key = candidate.uniqueName.toLowerCase();
    if (seen.has(key)) continue;
    seen.set(key, {
      id: candidate.id,
      displayName: candidate.displayName || candidate.uniqueName,
      uniqueName: candidate.uniqueName,
    });
    if (seen.size >= MAX_LINKED_IDENTITIES) break;
  }

  const linked = [...seen.values()];
  const all = [primary, ...linked];
  return {
    primary,
    linked,
    all,
    ids: new Set(all.map((i) => String(i.id).toLowerCase())),
    keys: new Set(all.map((i) => i.uniqueName.toLowerCase())),
    resolvedAt: new Date().toISOString(),
    degraded,
  };
}

/** The primary-only set — the FR-005 fallback, and what every person with
 * exactly one identity gets (the common case, at zero extra cost: no
 * candidate lookup is even attempted when this is used directly by a
 * caller that already knows there is nothing to discover). */
function primaryOnlySet(primary, { degraded = false } = {}) {
  return buildIdentitySet(primary, [], { degraded });
}

/**
 * Resolves the real candidate list for `primary` from two sources merged and
 * deduped by lowercased uniqueName (research.md R1):
 *
 *  - `findIdentitiesByLocalPart` (org-scoped IdentityPicker search) — the
 *    PRIMARY source, and the only one that can find an identity the project
 *    has never otherwise seen (e.g. a retired account with no recent
 *    assigned work in THIS project).
 *  - `peopleRoster` (this scope's own cached people list, from
 *    SyncEngine.ensurePeople) — a free SECONDARY source: any roster entry
 *    sharing the local part is merged in even if IdentityPicker's fuzzy
 *    search happens to miss it.
 *
 * On any failure (network, a malformed primary uniqueName, anything) this
 * resolves to `primaryOnlySet(primary, { degraded: true })` rather than
 * throwing — sign-in and every page must keep working even when discovery
 * cannot (FR-005, FR-012). Never awaited by the sign-in path itself; see
 * server/scopes.js for the lazy, cached call site.
 */
async function resolveIdentitySet(client, primary, peopleRoster) {
  if (!primary || !primary.uniqueName || !localPart(primary.uniqueName)) {
    return primaryOnlySet(primary, { degraded: false });
  }

  try {
    const picked = await findIdentitiesByLocalPart(client, primary.uniqueName);
    const rosterMatches = (peopleRoster || []).filter(
      (p) => p && p.uniqueName && localPart(p.uniqueName) === localPart(primary.uniqueName)
    );
    return buildIdentitySet(primary, [...picked, ...rosterMatches], { degraded: false });
  } catch (err) {
    return primaryOnlySet(primary, { degraded: true });
  }
}

module.exports = {
  MAX_LINKED_IDENTITIES,
  isEligibleLink,
  buildIdentitySet,
  primaryOnlySet,
  resolveIdentitySet,
};
