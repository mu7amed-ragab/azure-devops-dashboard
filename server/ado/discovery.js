/**
 * One-time (cached 24h) discovery of facts the rest of the app depends on:
 * - who "@Me" is
 * - how this process template represents a "Blocked" task, since there is
 *   no standard Blocked state in the Agile process template.
 *
 * Detection order: a real "blocked"-named state on any of User Story/Task/
 * Bug > CMMI Blocked field seen on a sample of tasks > a Blocked/blocked tag
 * seen on a sample of tasks. Whichever is found first is recorded, and the
 * UI is told which signal is active so it never claims certainty it doesn't
 * have.
 */

async function getIdentity(client) {
  // connectionData is a preview-only API — the org-wide api-version alone (e.g. 7.1) is rejected.
  const url = `https://dev.azure.com/${client.org}/_apis/connectionData?api-version=7.1-preview.1`;
  const data = await client.request(url, { method: 'GET' });
  const user = data.authenticatedUser || {};

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[discovery] raw authenticatedUser fields:', JSON.stringify({
      id: user.id,
      providerDisplayName: user.providerDisplayName,
      customDisplayName: user.customDisplayName,
      subjectDescriptor: user.subjectDescriptor,
      metaTypeId: user.metaTypeId,
      properties: user.properties,
    }, null, 2));
  }

  // WIQL matches on the account name (email), not the GUID, so it has to be
  // carried through — it lives under properties.Account, not as a top-level
  // field the way team-member identities expose `uniqueName`.
  const account = user.properties && user.properties.Account;
  const displayNameProp = user.properties && user.properties.DisplayName;

  // providerDisplayName is the real display name in most ADO configurations.
  // For some accounts it falls back to the UPN/email — in that case we prefer
  // the DisplayName property or customDisplayName.
  const displayName =
    user.customDisplayName ||
    (displayNameProp && displayNameProp.$value) ||
    user.providerDisplayName ||
    null;

  return {
    id: user.id,
    displayName,
    uniqueName: (account && account.$value) || user.providerDisplayName || null,
  };
}

/** Only used when a caller passes no discovered type list — see
 * server/ado/workItemTypes.js. Real callers pass this project's own types,
 * since a Scrum project has no 'User Story' to probe and a Basic project has
 * no 'Bug'. */
const DEFAULT_BLOCKED_SIGNAL_TYPES = ['User Story', 'Task', 'Bug'];

/**
 * @param {string[]} [types] the work item types to probe, from this project's
 *   own process template. The Blocked signal is itself a per-project fact (a
 *   custom process may add a real Blocked state where a stock one has none),
 *   so it must be detected against the types that project actually has.
 * @param {string[]} [taskTypes] the type to sample in step 2; the first entry
 *   is used, since sampling is a heuristic and one type is enough.
 */
async function detectBlockedSignal(client, { types, taskTypes } = {}) {
  const probeTypes = Array.isArray(types) && types.length > 0 ? types : DEFAULT_BLOCKED_SIGNAL_TYPES;
  const sampleType = (Array.isArray(taskTypes) && taskTypes[0]) || 'Task';
  // 1. A real workflow state whose name lowercases to "blocked", on any of
  // the work item types this app deals with — some processes only put it on
  // the requirement type, not the task type, so every type has to be probed.
  const matchedTypes = [];
  let foundValue = null;
  for (const type of probeTypes) {
    try {
      const states = await client.get(`/wit/workitemtypes/${encodeURIComponent(type)}/states`, {});
      const match = (states.value || []).find((s) => String(s.name).toLowerCase() === 'blocked');
      if (match) {
        matchedTypes.push(type);
        foundValue = foundValue || match.name;
      }
    } catch (err) {
      // process template may not expose this endpoint the same way; fall through
    }
  }
  if (matchedTypes.length > 0) {
    return { kind: 'state', field: 'System.State', value: foundValue, types: matchedTypes };
  }

  // 2. Sample recent tasks and look for the CMMI Blocked field or a Blocked tag
  try {
    const wiql = {
      // The System.TeamProject clause is required, not decorative: WIQL is
      // org-scoped even when the request URL names a project (see
      // teamProjectClause in ado/workitems.js). Without it this samples
      // whichever project's tasks happen to be most recent org-wide, and could
      // report a Blocked convention that doesn't exist in THIS project.
      query:
        `SELECT [System.Id] FROM WorkItems ` +
        `WHERE [System.TeamProject] = '${String(client.project).replace(/'/g, "''")}' ` +
        `AND [System.WorkItemType] = '${String(sampleType).replace(/'/g, "''")}' ` +
        `ORDER BY [System.ChangedDate] DESC`,
    };
    const result = await client.post('/wit/wiql', wiql, { query: { $top: 50 } });
    const ids = (result.workItems || []).slice(0, 50).map((w) => w.id);
    if (ids.length > 0) {
      const batch = await client.post('/wit/workitemsbatch', {
        ids,
        fields: ['System.Tags', 'Microsoft.VSTS.CMMI.Blocked'],
      });
      const items = batch.value || [];
      const hasCmmiField = items.some(
        (i) => i.fields && i.fields['Microsoft.VSTS.CMMI.Blocked'] !== undefined
      );
      if (hasCmmiField) {
        return { kind: 'field', field: 'Microsoft.VSTS.CMMI.Blocked', value: 'Yes' };
      }
      const hasTag = items.some((i) => {
        const tags = (i.fields && i.fields['System.Tags']) || '';
        return tags.split(';').map((t) => t.trim().toLowerCase()).includes('blocked');
      });
      if (hasTag) {
        return { kind: 'tag', field: 'System.Tags', value: 'Blocked' };
      }
    }
  } catch (err) {
    // best-effort — fall through to default
  }

  // 3. No signal found — default to tag convention, marked unconfirmed
  return { kind: 'tag', field: 'System.Tags', value: 'Blocked', unconfirmed: true };
}

/**
 * `getIdentity` is genuinely ORG-scoped (connectionData answers "who is this
 * token", which has nothing to do with a project); `detectBlockedSignal` is
 * project-scoped and is given this project's own types.
 */
async function discover(client, typeOptions) {
  const [identity, blockedSignal] = await Promise.all([
    getIdentity(client),
    detectBlockedSignal(client, typeOptions),
  ]);
  return { identity, blockedSignal, discoveredAt: new Date().toISOString() };
}

// ADO field `type` values that mean "boolean-valued or single-select" — the
// only kinds a blocked convention can sensibly name (FR-035c-iii). A free-
// text or numeric field is never offered, since there is no way to express
// "blocked" as one of its values. `Microsoft.VSTS.CMMI.Blocked` is the
// common real-world example, but it is discovered here like any other field,
// never assumed to exist (Constitution Principle II).
const ELIGIBLE_BLOCKED_FIELD_TYPES = new Set(['boolean', 'picklistString', 'picklistInteger', 'picklistDouble']);

/** The project's real boolean/single-select fields — what `options.fields`
 * in GET /api/scrum/blocked-convention offers (FR-035c-iii). Only a field
 * the project actually has can ever be saved into a convention.
 *
 * A14 note: this app does not yet discover a picklist field's real allowed
 * VALUES (only which fields are eligible) — that requires a second live ADO
 * hop (`GET /wit/fields/{ref}` -> `picklistId` -> `GET
 * /work/processes/lists/{id}`) whose exact response shape needs live
 * verification (plan.md Track C4) before this app depends on it. Until then,
 * the owner types the exact value that means blocked (matchBlocked's fix
 * compares it by equality, never truthiness) rather than being offered a
 * fabricated or wrong option list.
 */
async function fetchEligibleBlockedFields(client) {
  const result = await client.get('/wit/fields', {});
  const fields = (result && result.value) || [];
  return fields.filter((f) => ELIGIBLE_BLOCKED_FIELD_TYPES.has(f.type)).map((f) => f.referenceName);
}

module.exports = {
  discover,
  getIdentity,
  detectBlockedSignal,
  fetchEligibleBlockedFields,
  DEFAULT_BLOCKED_SIGNAL_TYPES,
  ELIGIBLE_BLOCKED_FIELD_TYPES,
};
