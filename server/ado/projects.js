/**
 * The projects a token can see in the organization — the list a person picks
 * from on the last step of sign-in (see POST /api/auth/project).
 *
 * "Can see" is not the same as "can read work items from": Project and Team
 * (Read) is enough to be listed here, while the dashboard also needs Work
 * Items (Read). That's why the selection step probes the chosen project
 * separately rather than trusting this list alone.
 */

// ADO caps $top at 1000 for this endpoint; 200 keeps a single page small
// enough to stay well inside the request timeout on slow links while still
// making one page enough for almost every organization.
const PAGE_SIZE = 200;

/**
 * @returns {Promise<Array<{id: string, name: string, description: string|null, visibility: string|null}>>}
 *   sorted by name, only well-formed (not deleting/creating) projects.
 */
async function listProjects(client) {
  const projects = [];
  let continuationToken;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const url = client.orgUrl('/projects', {
      $top: PAGE_SIZE,
      stateFilter: 'wellFormed',
      continuationToken,
    });
    // rawResponse: this endpoint pages via the x-ms-continuationtoken response
    // HEADER, not a field in the body, so client.get() can't see it.
    const res = await client.request(url, { method: 'GET', rawResponse: true, priority: true });
    const page = (res.data && res.data.value) || [];
    for (const p of page) {
      projects.push({
        id: p.id,
        name: p.name,
        description: p.description || null,
        visibility: p.visibility || null,
      });
    }
    continuationToken = res.headers['x-ms-continuationtoken'];
    if (!continuationToken || page.length === 0) break;
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listProjects };
