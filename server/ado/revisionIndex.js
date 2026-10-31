/**
 * Bulk revision history, replacing hundreds of per-work-item
 * `GET /wit/workItems/{id}/updates` calls (one full sync of a ~700-item
 * tree costs ~85s that way) with a handful of calls to the project-wide
 * reporting feed.
 *
 * `GET /wit/reporting/workitemrevisions` streams EVERY revision of EVERY
 * work item in the project, paged by continuation token, filtered to just
 * the fields we need. Unlike `/updates` (which only lists a revision when
 * that specific field changed, as an old/new pair), this feed reports the
 * field's CURRENT value at every revision snapshot regardless of whether
 * it changed that revision — so a delta only exists where the value
 * actually differs from the previous revision's value. Verified against
 * live data: reconstructing deltas this way reproduces `/updates` exactly
 * (cross-checked tasks 883238, 877882, 227931).
 */

// Fields carried by every project regardless of process template. The
// story-level estimate field is process-specific (StoryPoints/Effort/Size —
// see server/ado/estimateField.js) and is appended per call, since it isn't
// known until that project's requirement type has been discovered.
const BASE_REVISION_FIELDS = [
  'System.Id',
  'System.ChangedDate',
  'System.ChangedBy',
  'Microsoft.VSTS.Scheduling.CompletedWork',
  // v3 additions — see data-model.md §1. The reporting feed returns each
  // field's CURRENT value at every revision snapshot, so adding fields here
  // costs no extra calls; it only widens each page's payload.
  'Microsoft.VSTS.Scheduling.RemainingWork',
  'System.State',
  'System.IterationPath',
  'System.WorkItemType',
  // Not in data-model.md's original v3 shape — added during implementation.
  // Velocity and progress must aggregate completed/remaining work "across
  // the story and all its descendants" (FR-008a, FR-016), which needs a
  // story -> task hierarchy. Research R2 rules out a new WIQL query for
  // sprint membership; the same reasoning applies here; a project-wide
  // parent/child WIQL walk would be a second isolation-relevant query to
  // get right, so the hierarchy is derived from this field's history
  // instead — free, per R1's finding that added fields cost no extra calls.
  'System.Parent',
];

const PAGE_SIZE = 1000;

// Full project history starts well after this — measured ~93 pages / 78s
// covering everything back to here. An item whose earliest indexed
// revision already carries a nonzero CompletedWork is a "boundary" case
// (its real history starts before this window) and is seeded separately
// from the legacy per-item cache — see sync.js `ensureBoundarySeeded`.
const INDEX_START_DATE = '2025-01-01T00:00:00Z';

// Bumped whenever the index's per-entry shape changes in a way that makes
// old cached entries wrong to read as-is (not just missing a field the code
// tolerates being undefined). Bumping this forces sync.js to discard the
// persisted index and rewalk the whole project from INDEX_START_DATE — see
// SyncEngine.ensureRevisionIndex. v2: added `changedBy`, without which hours
// can't be attributed to whoever actually logged them (they'd all fall back
// to "current assignee", which is exactly the bug this version exists to
// fix). v3: added `remainingWork`, `state`, `iterationPath`, `estimate`, and
// `workItemType` for the Scrum page (velocity/burndown/scope-change/
// impediments). A v2 entry has no `remainingWork` key at all, and "absent"
// cannot be distinguished from "recorded as zero" — exactly the difference
// between "not tracked" (FR-033) and "nothing remaining" — so a v2 entry is
// wrong to read as v3 rather than merely incomplete.
const REVISION_INDEX_VERSION = 3;

/** System.ChangedBy on the reporting feed comes back as the legacy
 * "Display Name <email>" string (verified live — this API version does not
 * return an identity object here), so the email must be pulled out of the
 * angle brackets. Lowercased to match the uniqueName casing used everywhere
 * else identity is compared (WIQL clauses, the people list). */
function changedByKey(value) {
  if (!value || typeof value !== 'string') return null;
  const match = value.match(/<([^>]+)>/);
  const email = match ? match[1] : value;
  return email.trim().toLowerCase() || null;
}

function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v) {
  return v === undefined || v === null ? null : String(v);
}

async function fetchRevisionPage(client, fields, { startDateTime, continuationToken }) {
  const query = { fields, $top: PAGE_SIZE };
  if (continuationToken) query.continuationToken = continuationToken;
  else query.startDateTime = startDateTime;
  return client.get('/wit/reporting/workitemrevisions', { query });
}

/**
 * Pages the reporting feed from `startDateTime`, merging results into
 * `index` (Map<workItemId, Array<v3 entry>>, kept sorted by rev). Returns
 * the max ChangedDate observed, to resume from next time — a restart
 * re-requests from that watermark instead of re-walking the whole project.
 * `onPage(pages)`, if given, fires after every page — the only progress
 * signal available during a cold ~93-page/78s walk.
 *
 * @param {string|null} estimateField this project's own discovered
 *   story-level estimate field (server/ado/estimateField.js), or null on a
 *   project with none — the `estimate` entry key is then always null rather
 *   than requesting a field that doesn't exist.
 */
async function fetchRevisionsSince(client, startDateTime, index, onPage, estimateField = null) {
  const fields = (estimateField ? [...BASE_REVISION_FIELDS, estimateField] : BASE_REVISION_FIELDS).join(',');
  let token = null;
  let watermark = startDateTime;
  let pages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await fetchRevisionPage(client, fields, token ? { continuationToken: token } : { startDateTime });
    pages += 1;
    for (const v of page.values || []) {
      const id = v.id;
      const f = v.fields || {};
      const changedDate = f['System.ChangedDate'] || null;
      const entry = {
        rev: v.rev,
        changedDate,
        changedBy: changedByKey(f['System.ChangedBy']),
        completedWork: numOrNull(f['Microsoft.VSTS.Scheduling.CompletedWork']),
        remainingWork: numOrNull(f['Microsoft.VSTS.Scheduling.RemainingWork']),
        state: strOrNull(f['System.State']),
        iterationPath: strOrNull(f['System.IterationPath']),
        estimate: estimateField ? numOrNull(f[estimateField]) : null,
        workItemType: strOrNull(f['System.WorkItemType']),
        parentId: numOrNull(f['System.Parent']),
      };
      if (!index.has(id)) index.set(id, []);
      const arr = index.get(id);
      const existingIdx = arr.findIndex((e) => e.rev === v.rev);
      if (existingIdx >= 0) arr[existingIdx] = entry;
      else arr.push(entry);
      if (changedDate && changedDate > watermark) watermark = changedDate;
    }
    if (onPage) onPage(pages);
    if (page.isLastBatch) break;
    token = page.continuationToken;
    if (!token) break; // safety: no token but not marked last — stop rather than loop forever
  }

  for (const arr of index.values()) arr.sort((a, b) => a.rev - b.rev);
  return { watermark, pages };
}

module.exports = { fetchRevisionsSince, INDEX_START_DATE, REVISION_INDEX_VERSION, changedByKey, BASE_REVISION_FIELDS };
