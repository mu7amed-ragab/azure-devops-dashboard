/**
 * The set of people whose dashboard can be viewed. Azure DevOps has no
 * single "all project members" endpoint, so this unions two sources:
 *
 *  - project team rosters (walks the project's teams and dedupes their
 *    members by identity id)
 *  - everyone who has been assigned a work item in the last year (a project
 *    team roster only covers people someone remembered to add to a team —
 *    verified against live data that ~43% of people with recent assigned
 *    work were in no team at all and so were invisible to the picker)
 *
 * Group identities (e.g. "[Project]\Code Reviewers") are excluded — they
 * have no personal work assignment, so a dashboard for them is meaningless.
 */

const TEAMS_API = '7.1-preview.3';
const MEMBERS_API = '7.1-preview.2';
const PAGE_SIZE = 500;
const ASSIGNEE_LOOKBACK_DAYS = 365;
const ASSIGNEE_BATCH_SIZE = 200;
const ASSIGNEE_FETCH_CONCURRENCY = 8;
/**
 * Hard cap on the assignee-discovery query.
 *
 * Azure DevOps refuses a WIQL query whose result set exceeds 20,000 items —
 * `VS402337: The number of work items returned exceeds the size limit` — as a
 * 400. Unbounded, this query hit that on a large project (measured on a real
 * one: >20,000 items assigned-and-touched inside the lookback window), which
 * threw, took the whole people list down with it, and left the UI showing an
 * unresolved placeholder where names should be.
 *
 * 10,000 stays clear of the ceiling. Combined with the ORDER BY below it means
 * "the 10,000 most recently touched assigned items", which is the right sample
 * for the question being asked — who is active in this project — rather than an
 * arbitrary slice. The cost is bounded too: ids are hydrated 200 at a time, so
 * this is at most 50 batch requests, once a day.
 */
const ASSIGNEE_QUERY_LIMIT = 10000;

/** Pages a `{value: [...]}` ADO endpoint via $top/$skip until a short page ends it. */
async function fetchAllPages(client, url) {
  const items = [];
  let skip = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const separator = url.includes('?') ? '&' : '?';
    const res = await client.request(`${url}${separator}$top=${PAGE_SIZE}&$skip=${skip}`, { method: 'GET' });
    const page = res.value || [];
    items.push(...page);
    if (page.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return items;
}

async function fetchTeams(client) {
  const url = `https://dev.azure.com/${client.org}/_apis/projects/${encodeURIComponent(client.project)}/teams?api-version=${TEAMS_API}`;
  return fetchAllPages(client, url);
}

async function fetchTeamMembers(client, teamId) {
  const url = `https://dev.azure.com/${client.org}/_apis/projects/${encodeURIComponent(client.project)}/teams/${teamId}/members?api-version=${MEMBERS_API}`;
  return fetchAllPages(client, url);
}

/** Identities of everyone assigned a work item in the project within the
 * lookback window — the picker's second source, covering people who were
 * never added to a project team. */
async function fetchAssignedIdentities(client) {
  const query = `
    SELECT [System.Id]
    FROM WorkItems
    WHERE [System.TeamProject] = '${String(client.project).replace(/'/g, "''")}'
      AND [System.AssignedTo] <> ''
      AND [System.ChangedDate] >= @today-${ASSIGNEE_LOOKBACK_DAYS}
    ORDER BY [System.ChangedDate] DESC
  `.trim();

  // $top is what keeps this under ADO's 20,000-item result ceiling — see
  // ASSIGNEE_QUERY_LIMIT. The ORDER BY is what makes the truncation meaningful
  // rather than arbitrary.
  const result = await client.post('/wit/wiql', { query }, { query: { $top: ASSIGNEE_QUERY_LIMIT } });
  const ids = (result.workItems || []).map((w) => w.id);
  const chunks = [];
  for (let i = 0; i < ids.length; i += ASSIGNEE_BATCH_SIZE) chunks.push(ids.slice(i, i + ASSIGNEE_BATCH_SIZE));

  const identities = [];
  let cursor = 0;
  async function worker() {
    while (cursor < chunks.length) {
      const chunk = chunks[cursor++];
      const res = await client.post('/wit/workitemsbatch', { ids: chunk, fields: ['System.AssignedTo'] });
      for (const wi of res.value || []) {
        const assignedTo = wi.fields && wi.fields['System.AssignedTo'];
        if (assignedTo) identities.push(assignedTo);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ASSIGNEE_FETCH_CONCURRENCY, chunks.length) }, worker));
  return identities;
}

/** @returns {Promise<Array<{id, displayName, uniqueName}>>} sorted by display name */
async function fetchPeople(client) {
  const teams = await fetchTeams(client);
  const byId = new Map();

  function addIdentity(identity) {
    if (!identity || !identity.uniqueName || identity.isContainer) return;
    // Service accounts and group identities use vstfs:/// unique names.
    if (identity.uniqueName.startsWith('vstfs:///')) return;
    byId.set(identity.id, {
      id: identity.id,
      displayName: identity.displayName,
      uniqueName: identity.uniqueName,
    });
  }

  // Sequential rather than parallel: 22 team-member calls at once is enough
  // to trip the same connection limits that caused ECONNRESET during work
  // item sync, and this only runs once a day.
  for (const team of teams) {
    let members;
    try {
      members = await fetchTeamMembers(client, team.id);
    } catch (err) {
      continue; // a team we can't read shouldn't break the whole list
    }
    for (const member of members) addIdentity(member.identity);
  }

  // A SUPPLEMENT to the team rosters, and treated as one. It is the more
  // fragile of the two sources — it queries work items, so it scales with the
  // project's size, and it is where the 20,000-item ceiling bites. When it
  // fails, returning the roster people is strictly better than failing the
  // whole list: /api/people answering 502 leaves the person picker and every
  // name lookup in the UI with nothing to resolve against, which is a far worse
  // outcome than a picker missing the people who were never added to a team.
  try {
    const assignedIdentities = await fetchAssignedIdentities(client);
    for (const identity of assignedIdentities) addIdentity(identity);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[people] ${client.project}: assignee discovery failed (${err.message}); ` +
        `falling back to team rosters only (${byId.size} people)`
    );
  }

  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

module.exports = { fetchPeople };
