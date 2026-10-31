/** The real, per-type workflow states from Azure DevOps — never hardcoded.
 * Verified live: User Story has 20 states, Task 6, Bug 18, each with a
 * `category` (Proposed/InProgress/Resolved/Completed/Removed) suitable for
 * grouping in a picker. */
async function fetchStatesForTypes(client, types) {
  const entries = await Promise.all(
    types.map(async (type) => {
      const r = await client.get(`/wit/workitemtypes/${encodeURIComponent(type)}/states`);
      return [type, (r.value || []).map((s) => ({ name: s.name, category: s.category, color: s.color || null }))];
    })
  );
  return Object.fromEntries(entries);
}

/**
 * The workflow of EVERY type the project has (007-all-assigned-types), built
 * from the type list's own `states` where it carried them (one call, see
 * fetchEveryType in ado/workItemTypes.js) and from the per-type endpoint
 * otherwise. `fallbackTypes` (the requirement/task/bug names) are always
 * included, so a failed type-list call degrades to exactly the old map.
 *
 * A per-type failure drops just that type: it then has no entry, so
 * resolveWorkflow reports `known: false` and its items stay read-only — one
 * unreadable workflow never empties the whole map.
 */
async function statesFromEveryType(client, everyType, fallbackTypes = []) {
  const names = [...new Set([...Object.keys(everyType || {}), ...fallbackTypes])];
  const entries = await Promise.all(
    names.map(async (type) => {
      const listed = everyType && everyType[type] && everyType[type].states;
      if (Array.isArray(listed) && listed.length > 0) return [type, listed];
      try {
        const r = await client.get(`/wit/workitemtypes/${encodeURIComponent(type)}/states`);
        return [type, (r.value || []).map((s) => ({ name: s.name, category: s.category, color: s.color || null }))];
      } catch (err) {
        return null;
      }
    })
  );
  return Object.fromEntries(entries.filter(Boolean));
}

module.exports = { fetchStatesForTypes, statesFromEveryType };
