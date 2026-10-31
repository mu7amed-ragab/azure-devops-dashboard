/** Most recent activity on a PR — `createdDate` alone made a PR merged
 * yesterday sort as if it were stale just because it opened weeks ago. */
function prActivity(pr) {
  const created = pr.createdDate ? new Date(pr.createdDate).getTime() : 0;
  const closed = pr.closedDate ? new Date(pr.closedDate).getTime() : 0;
  return Math.max(created, closed);
}

function mostRecentActivity(prs) {
  return prs.reduce((max, pr) => Math.max(max, prActivity(pr)), 0);
}

function dedupePrs(prs) {
  const byId = new Map();
  for (const pr of prs) byId.set(pr.id, pr);
  return [...byId.values()].sort((a, b) => prActivity(b) - prActivity(a));
}

/**
 * Builds the Pull Requests page shape: repository -> user story -> PRs,
 * plus an `unattributed` bucket per repo for PRs that couldn't be resolved
 * to any story (see server/ado/prAttribution.js) — those carry whatever
 * work items were found as `linkedItems` tags instead.
 *
 * `attribution` is the Map<prId, {story, linkedItems}> from
 * attributePullRequests. PRs with no `repository` (a deleted/inaccessible
 * repo) are dropped — there's nothing to group them under.
 */
function buildRepoPrGroups(prs, attribution) {
  const repoGroups = new Map(); // key: repositoryId ?? repository name

  for (const pr of prs) {
    if (!pr.repository) continue;
    const key = pr.repositoryId || pr.repository;
    if (!repoGroups.has(key)) {
      repoGroups.set(key, {
        repository: pr.repository,
        repositoryId: pr.repositoryId || null,
        projectName: pr.projectName || null,
        storiesById: new Map(),
        unattributed: [],
      });
    }
    const group = repoGroups.get(key);
    const attr = attribution.get(pr.id) || { story: null, linkedItems: [] };

    if (attr.story) {
      if (!group.storiesById.has(attr.story.id)) {
        group.storiesById.set(attr.story.id, { ...attr.story, pullRequests: [] });
      }
      group.storiesById.get(attr.story.id).pullRequests.push(pr);
    } else {
      group.unattributed.push({ ...pr, linkedItems: attr.linkedItems });
    }
  }

  return [...repoGroups.values()]
    .map((g) => {
      const stories = [...g.storiesById.values()]
        .map((s) => ({ ...s, pullRequests: dedupePrs(s.pullRequests) }))
        .sort((a, b) => mostRecentActivity(b.pullRequests) - mostRecentActivity(a.pullRequests));
      const unattributed = dedupePrs(g.unattributed);
      return {
        repository: g.repository,
        repositoryId: g.repositoryId,
        projectName: g.projectName,
        stories,
        unattributed,
      };
    })
    .sort((a, b) => {
      const aActivity = Math.max(
        mostRecentActivity(a.stories.flatMap((s) => s.pullRequests)),
        mostRecentActivity(a.unattributed)
      );
      const bActivity = Math.max(
        mostRecentActivity(b.stories.flatMap((s) => s.pullRequests)),
        mostRecentActivity(b.unattributed)
      );
      return bActivity - aActivity;
    });
}

/** Exactly one bucket per PR — mirrors web/src/lib/prStatus.ts's `prStatusId`
 * exactly (draft checked first, since ADO has no separate "draft" status: a
 * draft PR is always also `status: 'active'`) so the server's chip counts
 * never disagree with how a PR is actually badged client-side. */
function prStatusId(pr) {
  if (pr.isDraft) return 'draft';
  if (pr.status === 'completed') return 'completed';
  if (pr.status === 'abandoned') return 'abandoned';
  return 'active';
}

/**
 * Per-repo PR summaries with NO PR bodies attached — repository, id, and
 * status are all on the cheap list fetch, so this costs zero attribution
 * HTTP calls. This is what `dashboard.prRepos` ships instead of the full
 * `repoPrGroups` array; the PR bodies themselves are paged in on demand via
 * GET /api/pullrequests (see server/index.js), which attributes only the
 * page being requested.
 */
function summarizePrRepos(prs) {
  const repoGroups = new Map(); // key: repositoryId ?? repository name

  for (const pr of prs) {
    if (!pr.repository) continue;
    const key = pr.repositoryId || pr.repository;
    if (!repoGroups.has(key)) {
      repoGroups.set(key, {
        repository: pr.repository,
        repositoryId: pr.repositoryId || null,
        projectName: pr.projectName || null,
        prCount: 0,
        statusCounts: { active: 0, draft: 0, completed: 0, abandoned: 0 },
        activity: 0,
      });
    }
    const group = repoGroups.get(key);
    group.prCount += 1;
    group.statusCounts[prStatusId(pr)] += 1;
    group.activity = Math.max(group.activity, prActivity(pr));
  }

  return [...repoGroups.values()]
    .sort((a, b) => b.activity - a.activity)
    .map(({ activity, ...rest }) => rest);
}

/** The free/cheap tier of search matching — no attribution HTTP calls,
 * since id, title, and status all live on the PR index already. Shared by
 * both PR routes (GET /api/pullrequests and GET /api/pullrequests/repos in
 * server/index.js) so "does this PR match the search" can never disagree
 * between them. */
function prCheapMatch(pr, q, lowerQ) {
  return String(pr.id).includes(q) || (!!pr.title && pr.title.toLowerCase().includes(lowerQ));
}

module.exports = { buildRepoPrGroups, summarizePrRepos, dedupePrs, prActivity, prStatusId, prCheapMatch };
