/**
 * The current-value counterpart to the revision index: the index answers
 * "what was this field at time T" for a fixed field list, and carries no
 * title, assignee, URL, or tags at all. This module is where those come
 * from — a project-scoped batch read of a work item id set, used for every
 * view that lists an item by name (progress, impediments, scope change).
 *
 * See plan.md, "The sprint work-item detail read", and data-model.md §2a.
 */

const BATCH_SIZE = 200;

const BASE_FIELDS = [
  'System.Id',
  'System.Title',
  'System.WorkItemType',
  'System.State',
  'System.AssignedTo',
  'System.IterationPath',
  'System.TeamProject',
  'System.Tags',
  'System.ChangedDate',
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function splitTags(raw) {
  if (!raw) return [];
  return String(raw)
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean);
}

function workItemUrl(org, project, id) {
  return `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}

/**
 * @param {object} client this project's AdoClient — `client.project` names
 *   the scope's own project, which is what the isolation re-check below
 *   compares every returned item's `System.TeamProject` against.
 * @param {number[]} ids ids to fetch — normally the set a sprint's
 *   IterationPath history (the revision index) says currently belongs to it.
 * @param {object} [options]
 * @param {string|null} [options.estimateField] this project's discovered
 *   story-level estimate field (server/ado/estimateField.js), requested only
 *   when one exists.
 * @param {string|null} [options.blockedField] the project's configured
 *   blocked field (US5), requested only when the convention names one — an
 *   unconfigured project requests no extra field.
 * @param {string} [options.statesByType] resolved per-item stateCategory —
 *   passed through from server/compute/workflow.js by the caller.
 * @returns {Promise<Array>} SprintItem records (data-model.md §2a), already
 *   filtered to this project.
 */
async function fetchSprintItems(client, ids, { estimateField = null, blockedField = null, statesByType = null } = {}) {
  if (!ids || ids.length === 0) return [];
  const fields = [...BASE_FIELDS];
  if (estimateField) fields.push(estimateField);
  if (blockedField) fields.push(blockedField);

  const chunks = chunk(ids, BATCH_SIZE);
  // errorPolicy: 'Omit' — the sprint's own id set can still name an item
  // that was hard-deleted or that this token can no longer read (observed
  // live: TF401232 on a since-removed work item), and ADO's default policy
  // fails the WHOLE batch over that one id. Omitting it here just drops that
  // one item from the sprint's detail list rather than crashing every view
  // that depends on this read.
  const results = await Promise.all(
    chunks.map((idsChunk) => client.post('/wit/workitemsbatch', { ids: idsChunk, fields, errorPolicy: 'Omit' }))
  );
  const raw = results.flatMap((r) => r.value || []);

  // THE ISOLATION RE-CHECK — not redundant. docs/architecture-server.md (Scrum
  // page) and docs/invariants.md (PR attribution) record the measured
  // behaviour: /wit/workitemsbatch returns any item the token can see, even
  // through a project-scoped URL — the exact property that makes
  // cross-project PR attribution work, and a hazard here. The id set already
  // comes from this project's own index, so this should never drop
  // anything; it is the guard that keeps "should never" from becoming a
  // silent leak (Constitution Principle I).
  const inProject = raw.filter((item) => (item.fields || {})['System.TeamProject'] === client.project);

  return inProject.map((item) => {
    const f = item.fields || {};
    const type = f['System.WorkItemType'] || 'Unknown';
    const state = f['System.State'] || null;
    const assignedTo = f['System.AssignedTo']
      ? { displayName: f['System.AssignedTo'].displayName || null, uniqueName: f['System.AssignedTo'].uniqueName || null }
      : null;
    const list = statesByType && statesByType[type];
    const meta = list && list.find((s) => s.name === state);
    return {
      id: item.id,
      title: f['System.Title'] || `#${item.id}`,
      type,
      state,
      stateCategory: meta ? meta.category : null,
      assignedTo,
      iterationPath: f['System.IterationPath'] || null,
      teamProject: f['System.TeamProject'] || null,
      tags: splitTags(f['System.Tags']),
      blockedField: blockedField ? f[blockedField] ?? null : null,
      estimate: estimateField ? (f[estimateField] ?? null) : null,
      changedDate: f['System.ChangedDate'] || null,
      url: workItemUrl(client.org, client.project, item.id),
    };
  });
}

module.exports = { fetchSprintItems, BASE_FIELDS };
