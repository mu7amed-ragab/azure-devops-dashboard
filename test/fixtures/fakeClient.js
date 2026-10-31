/**
 * A stand-in for AdoClient that answers from a fixture instead of the network,
 * and records every path it was asked for.
 *
 * The recording matters as much as the answers: several tests assert not just
 * "the right data came back" but "the request went to THIS project's URL", which
 * is the actual mechanism that keeps two projects apart.
 */

/**
 * @param {object} opts
 * @param {string} opts.project the project this client is scoped to
 * @param {object} [opts.process] one of test/fixtures/processes.js
 * @param {object} [opts.workItems] id -> { fields, rev, relations }
 * @param {Function} [opts.onPatch] called with (id, patchDocument); return a rev
 * @param {Array<object>} [opts.revisionPages] scriptable pages for
 *   /wit/reporting/workitemrevisions — each `{ values, continuationToken,
 *   isLastBatch }`, returned in order regardless of the requested
 *   continuationToken (a test drives paging by shape, not by token value).
 * @param {Array<object>} [opts.teams] `[{id, name}]` — this project's ADO
 *   teams, answering `GET /projects/{id}/teams` (US3).
 * @param {object} [opts.capacities] keyed `"<teamName>::<iterationId>"` ->
 *   the raw `{value: [...]}` shape the team-scoped capacities endpoint
 *   returns (US3) — answered via `client.request`, since that endpoint's URL
 *   carries a team segment `client.get` doesn't support.
 * @param {object} [opts.teamDaysOff] keyed `"<teamName>::<iterationId>"` ->
 *   the raw `{daysOff: [{start,end}]}` shape `.../teamdaysoff` returns (A1).
 * @param {object} [opts.teamSettings] keyed by team name -> the raw
 *   `{workingDays: [...]}` shape `.../teamsettings` returns (A1).
 * @param {Array<object>} [opts.fields] `[{referenceName, type}]` — this
 *   project's field list, answering `GET /wit/fields` (US5 field discovery).
 * @param {Array<number>} [opts.wiqlIds] work item ids `/wit/wiql` answers
 *   with (005-search-history-sprint-placement's queryEverAssigned, via
 *   SyncEngine.searchEverAssigned) — every WIQL POST gets this same list
 *   regardless of query text, since callers using this option issue at most
 *   one WIQL call per scenario. The query text itself is recorded on
 *   `wiqlQueries` for assertions.
 * @param {boolean} [opts.typesListWithoutStates] 007-all-assigned-types:
 *   the bare `GET /wit/workitemtypes` list normally answers one entry per
 *   type in `process.states`, each with `states` (name/category) and
 *   `fields` (from `process.typeFields`). `true` omits both, so callers'
 *   per-type fallback path is what gets exercised.
 */
function createFakeClient({
  project,
  org = 'test-org',
  process: proc,
  workItems = {},
  onPatch,
  revisionPages = null,
  teams = [],
  capacities = {},
  teamDaysOff = {},
  teamSettings = {},
  fields = [],
  wiqlIds = null,
  typesListWithoutStates = false,
} = {}) {
  const calls = [];
  const patches = [];
  const wiqlQueries = [];
  let revisionPageIndex = 0;

  function record(method, apiPath) {
    calls.push({ method, apiPath, project });
  }

  return {
    org,
    project,
    apiVersion: '7.1',
    calls,
    patches,
    wiqlQueries,

    async get(apiPath, options = {}) {
      record('GET', apiPath);
      if (apiPath === '/wit/workitemtypecategories') {
        if (!proc) throw Object.assign(new Error('no process fixture'), { status: 404 });
        return { value: proc.categories };
      }
      // 007-all-assigned-types: the bare type LIST — checked before the
      // /wit/workitemtypes/{t} patterns below.
      if (apiPath === '/wit/workitemtypes') {
        if (!proc) throw Object.assign(new Error('no process fixture'), { status: 404 });
        return {
          value: Object.keys(proc.states).map((name) =>
            typesListWithoutStates
              ? { name }
              : {
                  name,
                  states: proc.states[name].map((st) => ({ name: st.name, category: st.category, color: null })),
                  fields: ((proc.typeFields && proc.typeFields[name]) || []).map((referenceName) => ({ referenceName })),
                }
          ),
        };
      }
      if (apiPath === '/wit/reporting/workitemrevisions') {
        if (!revisionPages) return { values: [], isLastBatch: true };
        const page = revisionPages[revisionPageIndex] || { values: [], isLastBatch: true };
        revisionPageIndex += 1;
        return page;
      }
      const stateMatch = /^\/wit\/workitemtypes\/(.+)\/states$/.exec(apiPath);
      if (stateMatch) {
        const type = decodeURIComponent(stateMatch[1]);
        const states = proc && proc.states[type];
        if (!states) throw Object.assign(new Error(`unknown type ${type}`), { status: 404 });
        return { value: states };
      }
      // The bare type endpoint (no /states suffix) — used only for estimate-
      // field discovery (server/ado/estimateField.js), which reads
      // `fieldInstances`, distinct from the /states shape above.
      const typeMatch = /^\/wit\/workitemtypes\/([^/]+)$/.exec(apiPath);
      if (typeMatch) {
        const type = decodeURIComponent(typeMatch[1]);
        const fields = (proc && proc.fields && proc.fields[type]) || [];
        return { name: type, fieldInstances: fields.map((referenceName) => ({ referenceName })) };
      }
      const itemMatch = /^\/wit\/workitems\/(\d+)$/.exec(apiPath);
      if (itemMatch) {
        const item = workItems[itemMatch[1]];
        if (!item) throw Object.assign(new Error('not found'), { status: 404 });
        // Mirrors the real API: $expand=relations and an explicit fields list
        // are mutually exclusive, and callers rely on both shapes.
        if (options.query && options.query.$expand) {
          return { id: Number(itemMatch[1]), rev: item.rev, relations: item.relations || [] };
        }
        return { id: Number(itemMatch[1]), rev: item.rev, fields: item.fields };
      }
      if (apiPath === '/wit/fields') {
        return { value: fields };
      }
      const teamsMatch = /^\/projects\/[^/]+\/teams$/.exec(apiPath);
      if (teamsMatch) {
        return { value: teams };
      }
      if (apiPath === '/wiki/wikis') {
        return { value: [] }; // no wiki configured in this fixture by default
      }
      throw new Error(`fakeClient: unhandled GET ${apiPath}`);
    },

    /** Only capacities/teamsettings/teamdaysoff (team-scoped URLs, distinct
     * from the project-scoped shape `get` handles) are expected to arrive
     * here in tests today. */
    async request(url, options = {}) {
      const u = new URL(url);
      record(options.method || 'GET', u.pathname);
      const capMatch = /\/_apis\/work\/teamsettings\/iterations\/([^/]+)\/capacities$/.exec(u.pathname);
      if (capMatch) {
        const iterationId = decodeURIComponent(capMatch[1]);
        const segs = u.pathname.split('/');
        const apisIdx = segs.indexOf('_apis');
        const teamName = decodeURIComponent(segs[apisIdx - 1]);
        const value = capacities[`${teamName}::${iterationId}`];
        if (!value) throw Object.assign(new Error('no capacity recorded'), { status: 404 });
        return value;
      }
      const daysOffMatch = /\/_apis\/work\/teamsettings\/iterations\/([^/]+)\/teamdaysoff$/.exec(u.pathname);
      if (daysOffMatch) {
        const iterationId = decodeURIComponent(daysOffMatch[1]);
        const segs = u.pathname.split('/');
        const apisIdx = segs.indexOf('_apis');
        const teamName = decodeURIComponent(segs[apisIdx - 1]);
        const value = teamDaysOff[`${teamName}::${iterationId}`];
        if (!value) throw Object.assign(new Error('no team days off recorded'), { status: 404 });
        return value;
      }
      const settingsMatch = /\/_apis\/work\/teamsettings$/.exec(u.pathname);
      if (settingsMatch) {
        const segs = u.pathname.split('/');
        const apisIdx = segs.indexOf('_apis');
        const teamName = decodeURIComponent(segs[apisIdx - 1]);
        const value = teamSettings[teamName];
        if (!value) throw Object.assign(new Error('no team settings recorded'), { status: 404 });
        return value;
      }
      // No wiki configured in this fixture by default — every consumer
      // (server/orgStore.js) already treats a 404 here as "nothing set up
      // yet" rather than crashing, which is what lets scrum tests that don't
      // care about the org chart/blocked convention ignore it entirely.
      if (u.pathname.includes('/_apis/wiki/')) {
        throw Object.assign(new Error('no wiki'), { status: 404 });
      }
      throw new Error(`fakeClient: unhandled request ${u.pathname}`);
    },

    async post(apiPath, body, options = {}) {
      record('POST', apiPath);
      if (apiPath === '/wit/wiql') {
        wiqlQueries.push(body.query);
        return { workItems: (wiqlIds || []).map((id) => ({ id })) };
      }
      if (apiPath === '/wit/workitemsbatch') {
        return {
          value: (body.ids || [])
            .filter((id) => workItems[id])
            .map((id) => ({
              id: Number(id),
              rev: workItems[id].rev,
              fields: workItems[id].fields,
              // Mirrors the real endpoint: relations only come back with
              // $expand=Relations (hydrateWorkItemsWithRelations always
              // passes it) — included unconditionally here since no fixture
              // caller relies on their absence.
              relations: workItems[id].relations || [],
            })),
        };
      }
      throw new Error(`fakeClient: unhandled POST ${apiPath}`);
    },

    async patch(apiPath, patchDocument) {
      record('PATCH', apiPath);
      const id = Number(/(\d+)$/.exec(apiPath)[1]);
      patches.push({ id, patchDocument });
      if (onPatch) return onPatch(id, patchDocument);
      const item = workItems[id];
      if (item) item.rev = (item.rev || 1) + 1;
      return { id, rev: item ? item.rev : 2 };
    },
  };
}

/** Convenience: a work item as the batch/get endpoints shape it. */
function workItem({
  id,
  type,
  state,
  rev = 1,
  estimated = 0,
  completed = 0,
  remaining = 0,
  assignedToId = null,
  parentId = null,
  title = null,
  teamProject = null,
  iterationPath = null,
  tags = null,
  storyPoints = null,
  assignedToDisplayName = null,
  assignedToUniqueName = null,
  changedDate = null,
  extraFields = {},
}) {
  return {
    [id]: {
      rev,
      fields: {
        'System.Title': title || `Item ${id}`,
        'System.WorkItemType': type,
        'System.State': state,
        'System.Parent': parentId,
        'System.TeamProject': teamProject,
        'System.IterationPath': iterationPath,
        'System.Tags': tags,
        'System.ChangedDate': changedDate,
        'Microsoft.VSTS.Scheduling.OriginalEstimate': estimated,
        'Microsoft.VSTS.Scheduling.CompletedWork': completed,
        'Microsoft.VSTS.Scheduling.RemainingWork': remaining,
        'Microsoft.VSTS.Scheduling.StoryPoints': storyPoints,
        'System.AssignedTo': assignedToId
          ? { id: assignedToId, displayName: assignedToDisplayName, uniqueName: assignedToUniqueName }
          : null,
        ...extraFields,
      },
      relations: parentId
        ? [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/x/_apis/wit/workItems/${parentId}` }]
        : [],
    },
  };
}

/** A single revision-feed entry, shaped as `/wit/reporting/workitemrevisions`
 * returns it: the field's CURRENT value at this revision snapshot. */
function revisionEntry(id, rev, fields) {
  return { id, rev, fields };
}

/** One page of the revision feed, as fetchRevisionsSince consumes it. */
function revisionPage(values, { continuationToken = null, isLastBatch = true } = {}) {
  return { values, continuationToken, isLastBatch };
}

module.exports = { createFakeClient, workItem, revisionEntry, revisionPage };
