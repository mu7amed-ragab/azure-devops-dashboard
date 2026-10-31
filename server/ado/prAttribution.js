/**
 * Resolves each PR to the User Story (or top-level Bug) it belongs to,
 * replacing the old ArtifactLink-based attribution — verified against live
 * PR titles that only 1 in 25 mentions a work item number, so title
 * matching alone is far too weak to rely on.
 *
 * For every PR, three signals are gathered (always all three, not
 * short-circuited — a PR can carry a stray number in its title that isn't
 * actually its work item, so a later, more authoritative signal should
 * still run):
 *   1. numbers in the PR title
 *   2. ADO's own "linked work items" for the PR (the strongest signal —
 *      an explicit link, not text-mined)
 *   3. numbers in commit messages
 *
 * A candidate id resolves to a story by walking one hop up: a Task or Bug's
 * `System.Parent` is checked, same non-recursive one-hop rule the rest of
 * this codebase uses — Epics/Features are deliberately out of scope.
 *
 * Which types count as a "story" is the CURRENT project's answer, discovered
 * from its process template (server/ado/workItemTypes.js) and passed in by the
 * caller — 'User Story' on Agile, 'Product Backlog Item' on Scrum, 'Issue' on
 * Basic, 'Requirement' on CMMI, or whatever an inherited process renamed them
 * to. Only the fallback default below names types literally.
 */

const { fetchPrWorkItemRefs, fetchPrCommits, extractWorkItemIds } = require('./pullrequests');
const { mapWithConcurrency } = require('../util/concurrency');
const { DEFAULT_STORY_TYPES } = require('./workitems');

const CANDIDATE_CONCURRENCY = 8;
const BATCH_SIZE = 200;
const FIELDS = ['System.WorkItemType', 'System.Title', 'System.State', 'System.Parent'];

// Candidate work-item ids per PR (title/linked-items/commits numbers),
// keyed by PR id — the output of the 2-HTTP-call gather step, not the
// resolved story. A completed/abandoned PR never gets new commits or new
// work-item links, so its candidates are permanent; only `active` PRs are
// re-fetched. Shared across every person's sync since it's a property of
// the PR, not the viewer. Story details (title/state) are always re-read
// fresh from the batched summaries pass below, so this cache can never
// serve a stale StateChip.
const PR_CANDIDATE_CACHE_KEY = 'pr-candidates-v1';

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function dedupe(ids) {
  return [...new Set(ids)];
}

/** Fetches one batch, tolerating bad ids in it. Candidate ids come from
 * regex-matching free text (PR titles, commit messages) — an id that's
 * actually a version number, a hash fragment, or a work item this PAT
 * can't read makes `workitemsbatch` 404 for the WHOLE batch, not just that
 * id. On failure, bisect and retry each half so only the genuinely bad
 * id(s) are dropped rather than losing every valid candidate alongside it. */
async function fetchBatchResilient(client, ids, map) {
  if (ids.length === 0) return;
  try {
    const res = await client.post('/wit/workitemsbatch', { ids, fields: FIELDS });
    for (const wi of res.value || []) {
      const f = wi.fields || {};
      map.set(wi.id, {
        id: wi.id,
        type: f['System.WorkItemType'] || null,
        title: f['System.Title'] || '',
        state: f['System.State'] || null,
        parentId: f['System.Parent'] || null,
      });
    }
  } catch (err) {
    if (ids.length === 1) return; // this single id is bad — drop it
    // Sequential, not parallel — this only runs on the error path (a bad id
    // somewhere in the batch), where extra concurrency buys nothing.
    const mid = Math.ceil(ids.length / 2);
    await fetchBatchResilient(client, ids.slice(0, mid), map);
    await fetchBatchResilient(client, ids.slice(mid), map);
  }
}

/** Batch-fetches {type, title, state, parentId} for a set of work item ids. */
async function fetchWorkItemSummaries(client, ids) {
  const map = new Map();
  const chunks = chunk(dedupe(ids), BATCH_SIZE);
  await mapWithConcurrency(chunks, CANDIDATE_CONCURRENCY, (idsChunk) => fetchBatchResilient(client, idsChunk, map));
  return map;
}

/** Walks one hop from a candidate item to the story it belongs to: itself
 * if already a User Story/Bug, otherwise its immediate parent if that
 * parent is a User Story/Bug. Returns null if neither resolves. */
function resolveToStory(id, summaries, storyTypes) {
  const item = summaries.get(id);
  if (!item) return null;
  if (storyTypes.has(item.type)) return item;
  if (item.parentId) {
    const parent = summaries.get(item.parentId);
    if (parent && storyTypes.has(parent.type)) return parent;
  }
  return null;
}

/**
 * @param {Function} [onProgress] called as (done, total) after each PR's
 *   candidates are gathered — the longest opaque stretch of a cold sync
 *   (2 requests per PR), so this is what a sync-progress bar tracks during it.
 * @param {import('../cache').Cache} [cache] when given, closed PRs' gathered
 *   candidates are read from / written to it, skipping both HTTP calls on a
 *   cache hit — see PR_CANDIDATE_CACHE_KEY above.
 * @param {{storyTypes?: string[]}} [options] `storyTypes` is the current
 *   project's own requirement+bug type names (SyncEngine.ensureTypes); omitted
 *   only by callers that predate type discovery, which fall back to Agile.
 * @returns {Map<number, {story: {id,type,title,state}|null, linkedItems: Array<{id,type,title}>}>}
 * keyed by PR id.
 *
 * Note on `client`: every work-item lookup here goes through it, and it is
 * always the CURRENT project's client. That is what confines attribution to
 * the signed-in project — a candidate id mined from a PR title that happens to
 * belong to another project simply isn't readable through this client and is
 * dropped by fetchBatchResilient, so it can never surface as a "story" here.
 */
async function attributePullRequests(client, prs, onProgress, cache, options = {}) {
  const storyTypes = new Set(
    Array.isArray(options.storyTypes) && options.storyTypes.length > 0 ? options.storyTypes : DEFAULT_STORY_TYPES
  );
  const candidatesByPr = new Map();
  const cachedCandidates = cache ? cache.get(PR_CANDIDATE_CACHE_KEY) || {} : {};
  let cacheDirty = false;

  let cursor = 0;
  let done = 0;
  async function gatherWorker() {
    while (cursor < prs.length) {
      const pr = prs[cursor++];
      const closed = pr.status !== 'active';
      const cached = closed ? cachedCandidates[pr.id] : undefined;
      if (cached !== undefined) {
        candidatesByPr.set(pr.id, cached);
        done += 1;
        if (onProgress) onProgress(done, prs.length);
        continue;
      }
      const [linkedIds, commitMessages] = await Promise.all([
        fetchPrWorkItemRefs(client, pr).catch(() => []),
        fetchPrCommits(client, pr).catch(() => []),
      ]);
      const titleIds = extractWorkItemIds(pr.title);
      const commitIds = commitMessages.flatMap(extractWorkItemIds);
      const candidates = dedupe([...titleIds, ...linkedIds, ...commitIds]);
      candidatesByPr.set(pr.id, candidates);
      if (closed) {
        cachedCandidates[pr.id] = candidates;
        cacheDirty = true;
      }
      done += 1;
      if (onProgress) onProgress(done, prs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CANDIDATE_CONCURRENCY, prs.length) }, gatherWorker));
  if (cache && cacheDirty) cache.set(PR_CANDIDATE_CACHE_KEY, cachedCandidates);

  const allCandidateIds = [...candidatesByPr.values()].flat();
  const firstPass = await fetchWorkItemSummaries(client, allCandidateIds);

  const missingParentIds = [...firstPass.values()]
    .map((item) => item.parentId)
    .filter((id) => id && !firstPass.has(id));
  const parentSummaries = missingParentIds.length > 0 ? await fetchWorkItemSummaries(client, missingParentIds) : new Map();

  const summaries = new Map([...firstPass, ...parentSummaries]);

  const result = new Map();
  for (const pr of prs) {
    const candidateIds = candidatesByPr.get(pr.id) || [];
    let story = null;
    for (const id of candidateIds) {
      story = resolveToStory(id, summaries, storyTypes);
      if (story) break;
    }
    const linkedItems = story
      ? []
      : candidateIds
          .map((id) => summaries.get(id))
          .filter(Boolean)
          .map((item) => ({ id: item.id, type: item.type, title: item.title }));
    result.set(pr.id, {
      story: story ? { id: story.id, type: story.type, title: story.title, state: story.state } : null,
      linkedItems,
    });
  }
  return result;
}

module.exports = { attributePullRequests };
