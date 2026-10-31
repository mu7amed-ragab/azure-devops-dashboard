/**
 * Iteration (sprint) metadata for grouping/sorting stories and tasks.
 * System.IterationPath on a work item is a plain string like
 * "ProjectA\Sprint 78" — sorting those alphabetically is wrong
 * ("Sprint 149" < "Sprint 78" as strings). classificationnodes/Iterations
 * carries the real startDate/finishDate per node, which is what lets
 * sprints be ordered by when they actually happened.
 */

function flatten(node, parentPath, out) {
  const path = parentPath ? `${parentPath}\\${node.name}` : node.name;
  const attrs = node.attributes || {};
  out.set(path, {
    // `work/teamsettings/iterations/{iterationId}/capacities` (US3) wants the
    // iteration's GUID (`identifier`), NOT the classificationnodes integer
    // `id` — the two are different identifiers for the same node, and
    // passing the integer silently 400s/404s (read by capacity.js as "no
    // capacity recorded" rather than a real error, which made the mistake
    // invisible: every team's utilisation showed "Not recorded" always).
    id: node.identifier || null,
    name: node.name,
    path,
    startDate: attrs.startDate || null,
    finishDate: attrs.finishDate || null,
  });
  for (const child of node.children || []) {
    flatten(child, path, out);
  }
}

/** Map of full IterationPath -> { name, path, startDate, finishDate }. */
async function fetchIterationMap(client) {
  const root = await client.get('/wit/classificationnodes/Iterations', { query: { $depth: 6 } });
  const map = new Map();
  flatten(root, '', map);
  return map;
}

module.exports = { fetchIterationMap };
