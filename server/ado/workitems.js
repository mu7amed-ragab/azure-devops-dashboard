const BATCH_SIZE = 200;

/**
 * Stock-Agile names, used ONLY when a caller passes no discovered type list —
 * which in practice means a test or a caller predating type discovery. Real
 * callers pass the types the current project's process template actually uses
 * (see server/ado/workItemTypes.js and SyncEngine.ensureTypes), because
 * 'User Story'/'Task' exist on Agile and CMMI but not on Scrum ('Product
 * Backlog Item') or Basic ('Issue').
 */
const DEFAULT_STORY_TYPES = ['User Story', 'Bug'];

/** WIQL `IN (...)` list of single-quoted, escaped type names. */
function typeList(types, fallback) {
  const list = Array.isArray(types) && types.length > 0 ? types : fallback;
  return list.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(', ');
}

/**
 * A WIQL query is ORGANIZATION-scoped. This is the single most surprising fact
 * in this file, so it is stated plainly: putting the project in the request URL
 * (`{org}/{project}/_apis/wit/wiql`) does NOT restrict the results to that
 * project. Only an explicit `[System.TeamProject]` clause does.
 *
 * Measured against this org, one identity, the same leaf query:
 *
 *   without the clause   ProjectA 356 items   ProjectC 356 items
 *   with the clause      ProjectA 349 items   ProjectC   0 items
 *
 * — identical, org-wide totals without it. Every query in this file therefore
 * carries the clause, and any new one must too, or a project's dashboard will
 * quietly fill up with every other project's work.
 */
function teamProjectClause(client, prefix) {
  const name = String(client.project).replace(/'/g, "''");
  const field = prefix ? `[${prefix}].[System.TeamProject]` : '[System.TeamProject]';
  return `${field} = '${name}'`;
}

/**
 * One WIQL workItemLinks query returns the story->task hierarchy for items
 * you're assigned to (as story owner or task assignee) in a single round
 * trip. `since` (ISO date) makes this incremental after the first sync.
 */
function mergeLinks(links, storyIds, taskIds, parentOf) {
  for (const link of links) {
    if (!link.target) continue; // root-level nodes have no source
    if (!link.source) {
      storyIds.add(link.target.id);
    } else {
      storyIds.add(link.source.id);
      taskIds.add(link.target.id);
      parentOf.set(link.target.id, link.source.id);
    }
  }
}

/**
 * A date literal WIQL will actually accept for a `[System.ChangedDate] >`
 * comparison: `YYYY-MM-DD`, with no time part.
 *
 * Azure DevOps runs these queries at **date precision** and rejects a literal
 * carrying a time outright:
 *
 *   400 "You cannot supply a time with the date when running a query using date
 *        precision. The error is caused by
 *        «Source.[System.ChangedDate] > '2026-07-28T12:38:03.570Z'»."
 *
 * Callers pass a full ISO timestamp (that is what `new Date().toISOString()`
 * gives, and what the incremental-sync watermark is), so the time part is
 * trimmed here rather than at each call site — a caller cannot reasonably be
 * expected to know that WIQL is fussier than every other ADO endpoint.
 *
 * This was a live bug, not a hypothetical: the incremental/partial sync pass
 * (`since` non-null) failed with the above 400 on EVERY project and every
 * person. `_runSync` catches a failed partial pass and falls through to the full
 * pass, so nothing broke visibly — the fast first paint simply never happened,
 * and cold syncs were as slow as if the two-phase optimisation didn't exist.
 * Losing the time-of-day costs nothing here: the window is 14 days wide, and a
 * slightly wider one only means a few extra items in a pass that is meant to be
 * generous anyway.
 */
function wiqlDate(value) {
  const iso = String(value);
  const tIndex = iso.indexOf('T');
  return tIndex === -1 ? iso : iso.slice(0, tIndex);
}

/** WIQL string literals are single-quoted; a quote inside a name would
 * otherwise break out of the literal. Verified that an explicit
 * `= 'user@domain'` returns results identical to `@Me`, which is what
 * makes viewing another person's dashboard possible at all. */
function assignedToClause(uniqueName) {
  return `'${String(uniqueName).replace(/'/g, "''")}'`;
}

/**
 * 006-linked-identity-aliases: accepts either a single uniqueName (existing
 * callers, unchanged) or a person-shaped object carrying `identities` (an
 * IdentitySet — see server/identitySet.js) and returns the list of
 * uniqueNames every widened query should match against. A single-identity
 * person (the common case) yields exactly one name — same as before this
 * feature existed, so nothing about the generated query changes for them.
 */
function identityNames(uniqueNameOrPerson) {
  if (uniqueNameOrPerson && typeof uniqueNameOrPerson === 'object') {
    const all = (uniqueNameOrPerson.identities && uniqueNameOrPerson.identities.all) || [uniqueNameOrPerson];
    return all.map((i) => i.uniqueName).filter(Boolean);
  }
  return [uniqueNameOrPerson];
}

/**
 * `[field] = 'a' OR [field] = 'b' OR ...`, parenthesised as ONE unit so a
 * caller can safely `AND` it alongside `teamProjectClause` without the OR
 * silently widening past the surrounding AND (`A AND (B OR C)`, never
 * `A AND B OR C` — see research.md R2 and
 * test/linkedIdentityScoping.test.js, which asserts this text shape
 * directly). Falls back to a single `=` with no parentheses when there is
 * only one name, so the generated query for the common single-identity case
 * is byte-for-byte what it was before this function existed.
 */
function assigneeOrClause(field, names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return `${field} = ${assignedToClause(list[0])}`;
  return `(${list.map((n) => `${field} = ${assignedToClause(n)}`).join(' OR ')})`;
}

/** The `<>` mirror of `assigneeOrClause`: "not equal to ANY of these",
 * i.e. `[field] <> 'a' AND [field] <> 'b' AND ...` — used by
 * `queryEverAssigned` so an item currently assigned to ANY of the person's
 * identities is excluded, not just the primary (an item merely moved from
 * the old identity to the new one must not be reported as past-owned). */
function assigneeNotAnyClause(field, names) {
  const list = (names || []).filter(Boolean);
  if (list.length === 0) return '1 = 1';
  return list.map((n) => `${field} <> ${assignedToClause(n)}`).join(' AND ');
}

/** The `EVER` mirror of `assigneeOrClause`: "was ever assigned to ANY of
 * these", parenthesised as one OR-group for the same reason. */
function everAssignedOrClause(field, names) {
  const list = (names || []).filter(Boolean);
  if (list.length <= 1) return `${field} EVER ${assignedToClause(list[0])}`;
  return `(${list.map((n) => `${field} EVER ${assignedToClause(n)}`).join(' OR ')})`;
}

/**
 * Azure DevOps WIQL link queries reject an OR that mixes Source/Target
 * prefixes ("The link query can not mix expression with different
 * prefixes"). So instead of one query with
 * (Source.AssignedTo = X OR Target.AssignedTo = X), this runs two
 * single-prefix queries — stories the person owns, and stories that merely
 * contain a task assigned to them — and merges the resulting trees.
 *
 * `uniqueName` accepts either a plain string (unchanged, existing callers)
 * or a person object carrying `.identities` (006-linked-identity-aliases) —
 * see `identityNames`. A widened, multi-identity assignee condition is its
 * own parenthesised OR-group (`assigneeOrClause`), so it can never be read
 * as loosening the surrounding `AND (teamProjectClause)` — see research.md
 * R2 and test/linkedIdentityScoping.test.js.
 */
async function queryAssignedTree(client, uniqueName, { since, storyTypes } = {}) {
  const types = typeList(storyTypes, DEFAULT_STORY_TYPES);
  const names = identityNames(uniqueName);

  // Deliberately no MODE(Recursive): we only want direct story -> task
  // links. Recursive mode walks the full hierarchy (epics, features,
  // everything transitively linked) and blows past ADO's 20,000-item
  // query limit on any non-trivial project.
  const buildQuery = (assigneePrefix, changedPrefix) => `
    SELECT [System.Id]
    FROM workItemLinks
    WHERE ([Source].[System.WorkItemType] IN (${types}))
      AND ([System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward')
      AND (${assigneeOrClause(`[${assigneePrefix}].[System.AssignedTo]`, names)})
      AND ([Source].[System.State] <> 'Removed')
      AND (${teamProjectClause(client, 'Source')})
      AND (${teamProjectClause(client, 'Target')})
      ${since ? `AND ([${changedPrefix}].[System.ChangedDate] > '${wiqlDate(since)}')` : ''}
  `.trim();

  const [bySource, byTarget] = await Promise.all([
    client.post('/wit/wiql', { query: buildQuery('Source', 'Source') }),
    client.post('/wit/wiql', { query: buildQuery('Target', 'Target') }),
  ]);

  const storyIds = new Set();
  const taskIds = new Set();
  const parentOf = new Map(); // taskId -> storyId

  mergeLinks(bySource.workItemRelations || [], storyIds, taskIds, parentOf);
  mergeLinks(byTarget.workItemRelations || [], storyIds, taskIds, parentOf);

  return { storyIds: [...storyIds], taskIds: [...taskIds], parentOf };
}

/**
 * EVERY item assigned to the person in this project, whatever its type —
 * a flat query, not a link query, since an unparented item by definition
 * has nothing to traverse from. Callers cross-reference the result against
 * `parentOf` from queryAssignedTree to find the ones not already in a story
 * tree, and place those by type CATEGORY (classifyByCategory in
 * ado/workItemTypes.js).
 *
 * No type clause, on purpose (007-all-assigned-types, research.md R1): "what
 * is assigned to me" must not depend on which type an item was created as,
 * and a clause with no type list is the one form that can't be wrong on a
 * custom process. No state clause either (research.md R13): a literal
 * `<> 'Removed'` only matches the stock state NAME (Principle II), so the
 * caller drops Removed-CATEGORY items after hydration instead.
 * `teamProjectClause` and the assignee OR-group stay exactly as everywhere
 * else in this file.
 */
async function queryAssignedItems(client, uniqueName, { since } = {}) {
  const query = `
    SELECT [System.Id]
    FROM WorkItems
    WHERE ${teamProjectClause(client)}
      AND ${assigneeOrClause('[System.AssignedTo]', identityNames(uniqueName))}
      ${since ? `AND [System.ChangedDate] > '${wiqlDate(since)}'` : ''}
  `.trim();

  const result = await client.post('/wit/wiql', { query });
  return (result.workItems || []).map((w) => w.id);
}

/**
 * Mirrors Azure DevOps's own "Recently updated" work item page, scoped to
 * one person: everything assigned to them, changed within the window,
 * newest first. Deliberately no state or iteration filter here — those
 * exist to keep the sprint-grouped view current, and applying them here
 * would silently drop exactly the items this list exists to surface (e.g.
 * something that shipped in an old sprint but was touched yesterday).
 * `[System.State] <> 'Removed'` mirrors every other query in this file —
 * a Removed item is never a real result anywhere in the app.
 *
 * This was the ONLY query here that already carried a System.TeamProject
 * clause; the other two have it now (see teamProjectClause).
 */
async function queryRecentlyUpdated(client, uniqueName, days) {
  const query = `
    SELECT [System.Id]
    FROM WorkItems
    WHERE ${teamProjectClause(client)}
      AND ${assigneeOrClause('[System.AssignedTo]', identityNames(uniqueName))}
      AND [System.ChangedDate] >= @today-${days}
      AND [System.State] <> 'Removed'
    ORDER BY [System.ChangedDate] DESC
  `.trim();

  const result = await client.post('/wit/wiql', { query });
  return (result.workItems || []).map((w) => w.id);
}

/**
 * WIQL `EVER` evaluates a field across a work item's WHOLE revision history
 * rather than its current value — the only way to ask "was this person ever
 * assigned this item?" in one round trip, instead of walking every
 * candidate's `/updates` history (what ado/revisionIndex.js does for the
 * person's OWN assigned tree, which is exactly the set this exists to look
 * beyond). Combined with `<> uniqueName` on the CURRENT value, this answers
 * "assigned at some point, not assigned now" server-side, so the caller never
 * has to hand in a current-id exclusion list.
 *
 * LIVE VERIFICATION (research.md R1 / quickstart.md step 1 / T003) — done,
 * against this org, one identity, ProjectA:
 *
 *   [System.AssignedTo] EVER '<user>'                            549 items, 200 (not 400)
 *   + AND [System.AssignedTo] <> '<user>' (the exclusion clause)  115 items, 0 overlap with the
 *                                                                 432 currently-assigned items
 *   same query, [System.TeamProject] = 'ProjectC'                  0 items
 *
 * `EVER` is accepted, returns real reassignment history, and TeamProject
 * still constrains it exactly like every other query in this file — the
 * same measurement style as teamProjectClause's own comment above.
 */
function everAssignedClause(uniqueName) {
  return `[System.AssignedTo] EVER ${assignedToClause(uniqueName)}`;
}

/**
 * The text predicate for /api/workitems/search — mirrors the client's
 * existing in-memory match (id fragment or title substring) as closely as
 * WIQL allows, per research.md R3: title/tags CONTAINS (substring), plus an
 * exact `[System.Id] =` when `q` is purely numeric (WIQL cannot substring-
 * match an integer field, so a numeric query only finds an EXACT id this
 * way — documented divergence, data-model.md §7). `q`'s quote is escaped the
 * same way assignedToClause already escapes a uniqueName.
 */
function searchTextClause(q) {
  const escaped = String(q).replace(/'/g, "''");
  const titleOrTags = `([System.Title] CONTAINS '${escaped}' OR [System.Tags] CONTAINS '${escaped}')`;
  if (/^\d+$/.test(q.trim())) {
    return `([System.Id] = ${Number(q.trim())} OR ${titleOrTags})`;
  }
  return titleOrTags;
}

/**
 * Items in this project that `uniqueName` was EVER assigned and is NOT
 * assigned to now, matching `q` (title/tags substring, or exact id). Backs
 * GET /api/workitems/search (contracts/search-workitems.md).
 *
 * Deliberately NO visible-state filter and NO MIN_ITERATION_YEAR filter —
 * see research.md R5: those exist to keep the sprint-grouped view current,
 * and applying them here would drop exactly what this feature exists to
 * find (an old, closed item from a sprint outside the grouped view's
 * window). Only `[System.State] <> 'Removed'` applies — a Removed item is
 * never a real result anywhere in this app. That literal is an inherited
 * Principle II exception, recorded in the original design notes
 * (Complexity Tracking); queryAssignedItems has already moved to a
 * category-based exclusion.
 *
 * Every TYPE is searched (007-all-assigned-types, research.md R7): a
 * formerly owned Feature is found exactly like a formerly owned Task, and a
 * query with no type list can't name a type wrong on a custom process.
 */
async function queryEverAssigned(client, uniqueName, { q, top = 50 } = {}) {
  // 006-linked-identity-aliases: both halves widen to the whole identity
  // set. EVER becomes an OR-group ("ever assigned to ANY identity"), and the
  // exclusion becomes an AND-group of <> ("currently assigned to NONE of
  // them") — otherwise an item merely moved from the person's OLD identity
  // to their NEW one would still show up here as "past-owned" when it is in
  // fact their current work. A single-identity person (the common case)
  // produces byte-identical text to the pre-widening query — see
  // everAssignedClause/assignedToClause above, which everAssignedOrClause /
  // assigneeNotAnyClause fall back to for exactly one name.
  const names = identityNames(uniqueName);
  const query = `
    SELECT [System.Id] FROM WorkItems
    WHERE ${teamProjectClause(client)}
      AND ${everAssignedOrClause('[System.AssignedTo]', names)}
      AND ${assigneeNotAnyClause('[System.AssignedTo]', names)}
      AND [System.State] <> 'Removed'
      AND ${searchTextClause(q)}
    ORDER BY [System.ChangedDate] DESC
  `.trim();

  const result = await client.post('/wit/wiql', { query }, { query: { $top: top } });
  const ids = (result.workItems || []).map((w) => w.id);
  // WIQL's $top caps the SELECT, so a full page means there may be more —
  // the endpoint reports `truncated` off this rather than a separate count
  // query (FR-010).
  return { ids: ids.slice(0, top), truncated: ids.length >= top };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Fetches full work items (all fields) with relations expanded, used for
 * every kind of item — stories, tasks, unparented items alike. Relations
 * are needed to resolve linked PRs (ArtifactLink). Azure DevOps rejects
 * combining $expand with an explicit fields list ("The expand parameter
 * can not be used with the fields parameter"), so this always fetches the
 * full field set instead — callers read the specific keys they need off
 * `fields`, e.g. normalizeTask/rollupStory in compute/rollup.js.
 */
async function hydrateWorkItemsWithRelations(client, ids) {
  if (ids.length === 0) return [];
  const chunks = chunk(ids, BATCH_SIZE);
  const results = await Promise.all(
    chunks.map((idsChunk) => client.post('/wit/workitemsbatch', { ids: idsChunk, $expand: 'Relations' }))
  );
  return results.flatMap((r) => r.value || []);
}

/**
 * Just the title and type for a set of ids — the cheap counterpart to
 * `hydrateWorkItemsWithRelations` for callers that only need to LABEL an item
 * they already have the numbers for (server/crossHours.js's drill-down).
 *
 * A chunk containing an id this token can't read (or that was deleted) makes
 * `workitemsbatch` fail for the WHOLE chunk, so a failed chunk is dropped
 * rather than retried id-by-id: every caller here already falls back to `#id`,
 * which is a better answer than N extra requests for a cosmetic field.
 *
 * @returns {Promise<Array<{id:number, title:string, type:string}>>}
 */
async function fetchWorkItemTitles(client, ids) {
  if (ids.length === 0) return [];
  const chunks = chunk(ids, BATCH_SIZE);
  const results = await Promise.all(
    chunks.map(async (idsChunk) => {
      try {
        const res = await client.post('/wit/workitemsbatch', {
          ids: idsChunk,
          fields: ['System.Title', 'System.WorkItemType'],
        });
        return res.value || [];
      } catch (err) {
        return [];
      }
    })
  );
  return results.flat().map((wi) => {
    const f = wi.fields || {};
    return {
      id: wi.id,
      title: f['System.Title'] || `#${wi.id}`,
      type: f['System.WorkItemType'] || 'Unknown',
    };
  });
}

/** Revisions of a single work item's CompletedWork field over time, for the hours-per-day timeline. */
async function getWorkItemUpdates(client, id) {
  const result = await client.get(`/wit/workItems/${id}/updates`, {});
  return result.value || [];
}

module.exports = {
  wiqlDate,
  DEFAULT_STORY_TYPES,
  queryAssignedTree,
  queryAssignedItems,
  queryRecentlyUpdated,
  everAssignedClause,
  queryEverAssigned,
  hydrateWorkItemsWithRelations,
  fetchWorkItemTitles,
  getWorkItemUpdates,
  // 006-linked-identity-aliases — exported for test/linkedIdentityScoping.test.js,
  // which asserts on the generated query TEXT shape directly.
  identityNames,
  assigneeOrClause,
  assigneeNotAnyClause,
  everAssignedOrClause,
};
