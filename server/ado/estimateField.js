/**
 * The story-level estimate field name is a process-template property, exactly
 * like state and type names (see server/compute/workflow.js): Agile calls it
 * StoryPoints, Scrum calls it Effort, CMMI calls it Size, and a project on
 * Basic (or a custom process that dropped it) has none of them at all.
 * FR-013a requires this be discovered per project rather than assumed.
 *
 * `GET /wit/workitemtypes/{type}` returns the type's `fieldInstances` — the
 * fields that type actually carries — which is project-scoped by
 * construction (AdoClient.projectUrl), so the answer belongs to the caller's
 * project alone.
 */

const CANDIDATE_FIELDS = [
  { field: 'Microsoft.VSTS.Scheduling.StoryPoints', label: 'Story Points' },
  { field: 'Microsoft.VSTS.Scheduling.Effort', label: 'Effort' },
  { field: 'Microsoft.VSTS.Scheduling.Size', label: 'Size' },
];

/**
 * @param {string[]} requirementTypes this project's own backlog-level types
 *   (server/ado/workItemTypes.js), never a fixed 'User Story'/'Product
 *   Backlog Item' guess.
 * @returns {Promise<{field: string, label: string} | null>} null when every
 *   requirement type was successfully checked and none carry a candidate
 *   field — FR-013a's "velocity unavailable" case, not a zero. Throws rather
 *   than returning null when EVERY type's check failed (e.g. a transient
 *   network error), so a caller can distinguish "confirmed absent" from
 *   "couldn't check" instead of silently baking a wrong answer into
 *   anything cached from this call (see server/sync.js's ensureEstimateField
 *   and the v3 revision-index build that reads it).
 */
async function discoverEstimateField(client, requirementTypes) {
  let anyChecked = false;
  let lastError = null;
  for (const type of requirementTypes || []) {
    let fieldNames;
    try {
      const res = await client.get(`/wit/workitemtypes/${encodeURIComponent(type)}`);
      fieldNames = new Set((res.fieldInstances || []).map((f) => f.referenceName));
      anyChecked = true;
    } catch (err) {
      lastError = err; // this type's field list is unavailable; try the next one
      continue;
    }
    const hit = CANDIDATE_FIELDS.find((c) => fieldNames.has(c.field));
    if (hit) return hit;
  }
  if (!anyChecked && requirementTypes && requirementTypes.length > 0) {
    throw lastError || new Error('estimate field discovery: no requirement type could be checked');
  }
  return null;
}

module.exports = { discoverEstimateField, CANDIDATE_FIELDS };
