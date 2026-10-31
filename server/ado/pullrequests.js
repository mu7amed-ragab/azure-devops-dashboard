/**
 * Pull request fetch for one person (creator only — PRs the person merely
 * reviews are excluded by request, so "your PRs" means "PRs you opened"),
 * plus the raw building blocks for attributing each PR to a work item —
 * see server/ado/prAttribution.js for how these are combined.
 *
 * ---------------------------------------------------------------------------
 * ORGANIZATION-scoped, deliberately — the one exception in an otherwise
 * strictly project-scoped app (see the scoping audit in server/scopes.js).
 * ---------------------------------------------------------------------------
 * Azure DevOps offers this search both ways: `{org}/_apis/git/pullrequests`
 * (every project the token can see) and `{org}/{project}/_apis/git/pullrequests`
 * (one project). This uses the ORG form on purpose.
 *
 * The reason is what the Pull Requests page is FOR. A story is delivered across
 * whatever repositories the change touches, and in this org those repositories
 * do not all live in the story's own project. Narrowing the search to the
 * signed-in project makes "show me everything that shipped this story" quietly
 * incomplete, and makes the page's search box unable to find a PR the person
 * knows exists. Being able to find every PR attached to a story was judged more
 * valuable than symmetry with the other pages.
 *
 * Two things make that safe rather than merely convenient:
 *  - Attribution genuinely works across projects. `/wit/workitemsbatch` reads a
 *    work item from any project the token can see, even through a project-scoped
 *    URL (verified live), so a PR in project B that references a story in
 *    project A resolves to that story instead of falling into the
 *    "not linked to a story" bucket.
 *  - Every PR carries its own `projectName`, and the UI shows it whenever it
 *    differs from the signed-in project — so cross-project PRs are labelled,
 *    not silently mixed in.
 *
 * This is a considered exception, not an oversight. The only other view that
 * spans projects is cross-project hours (server/crossHours.js), and it does so
 * differently: it WALKS the scope registry, reading each project through its
 * own scope, and labels every row with the project it came from. Anything else
 * reaching across projects — a query, a cache key, a view that mixes two
 * projects' items without saying so — is a bug.
 */

const { prActivity } = require('../compute/prGroups');

const PR_PAGE_SIZE = 200;

/** Pages one `searchCriteria.*Id` PR search until a short page ends it —
 * the old code capped every criteria at 200 PRs with no $skip, silently
 * truncating anyone with more history than that.
 *
 * `org: true` selects the organization-wide PR search — see the module comment
 * above for why that is the intended scope here. */
async function fetchAllPrPages(client, criteriaKey, identityId) {
  const items = [];
  let skip = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await client.get('/git/pullrequests', {
      org: true,
      query: { [criteriaKey]: identityId, 'searchCriteria.status': 'all', $top: PR_PAGE_SIZE, $skip: skip },
    });
    const page = res.value || [];
    items.push(...page);
    if (page.length < PR_PAGE_SIZE) break;
    skip += PR_PAGE_SIZE;
  }
  return items;
}

/**
 * Every PR this identity created, org-wide.
 *
 * A completely empty result is retried once. `fetchAllPrPages` stops on the
 * first short page, so a response of `{value: []}` reads as "this person has no
 * pull requests" — there is no error to catch and nothing to distinguish it from
 * the truth. That is a bad property for the one signal the entire Pull Requests
 * page is built from: observed live, a sync of a large project came back with
 * zero PRs where a standalone call to the same endpoint, with the same token and
 * the same identity, returned 1268 — and the empty result was then cached, so
 * the page stayed blank afterwards. The cause upstream was not pinned down (it
 * coincided with heavy `X-RateLimit-Delay` throttling), so this does not pretend
 * to fix it; it makes a single transient empty response survivable, which is
 * cheap and correct either way.
 *
 * The retry costs one request, and only on the suspicious path — someone who
 * genuinely has no pull requests pays it once per sync, which is nothing next to
 * the rest of a sync. If the second attempt is also empty, that is believed.
 * See also the guard in SyncEngine._runSyncPass, which refuses to overwrite a
 * non-empty PR index with an empty one: these are two independent defences
 * because neither is sufficient on its own.
 */
/** One identity's PRs, with the empty-result retry above. Kept as its own
 * function so the retry runs PER IDENTITY — see fetchPullRequests below for
 * why that placement matters once there is more than one identity to
 * fetch. */
async function fetchPullRequestsForIdentity(client, identityId) {
  let created = await fetchAllPrPages(client, 'searchCriteria.creatorId', identityId);
  if (created.length === 0) {
    created = await fetchAllPrPages(client, 'searchCriteria.creatorId', identityId);
    if (created.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pr] the pull request search returned nothing on the first attempt and ${created.length} on the second — ` +
          'the first response was spurious.'
      );
    }
  }
  return created;
}

/**
 * 006-linked-identity-aliases: `identityId` accepts either a single id
 * (existing callers, unchanged — the common single-identity case makes
 * exactly the same one search it always did) or an ARRAY of ids, one PR
 * search per identity, unioned by `pullRequestId` so a PR is never counted
 * twice (a person cannot create the same PR under two identities, but
 * defensive dedupe costs nothing and matches every other data kind in this
 * feature).
 *
 * The empty-result retry from `fetchPullRequestsForIdentity` stays INSIDE
 * each per-identity fetch, run one identity at a time before the next
 * identity's fetch even starts — deliberately not `Promise.all`, so one
 * identity's spurious `{value: []}` (the real incident this retry exists
 * for — see the function comment above) cannot race ahead of its own retry
 * and get unioned into the result before the retry corrects it. Each
 * identity gets its own independent chance to recover from that failure
 * mode; the union is only ever built from responses that already survived
 * it.
 */
async function fetchPullRequests(client, identityId) {
  const ids = Array.isArray(identityId) ? identityId : [identityId];
  const byId = new Map();
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    const created = await fetchPullRequestsForIdentity(client, id);
    for (const pr of created) {
      byId.set(pr.pullRequestId, pr);
    }
  }
  return [...byId.values()];
}

/** Keeps only PRs still `active`, or whose most recent activity
 * (created/closed, whichever is later) falls within the last `months` —
 * the single biggest cost lever on a cold sync, since attribution is 2 HTTP
 * requests per PR. `months <= 0` disables the cutoff (full history). */
function filterPrHistoryWindow(prs, months) {
  if (!months || months <= 0) return prs;
  const cutoff = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  return prs.filter((pr) => pr.status === 'active' || prActivity(pr) >= cutoff);
}

/**
 * `org` must be passed explicitly: the org-wide PR search can legitimately
 * return PRs from a DIFFERENT Azure DevOps project than the one configured
 * in .env (e.g. a PR in "ProjectB" while the dashboard is configured for
 * "ProjectA") — the URL needs {org}/{that PR's own project}, never the
 * dashboard's configured project. The previous version dropped the org
 * entirely and used the project name in its place, so every link 404'd.
 */
function normalizePr(pr, org) {
  return {
    id: pr.pullRequestId,
    title: pr.title,
    status: pr.status, // active | completed | abandoned
    isDraft: !!pr.isDraft,
    repository: pr.repository ? pr.repository.name : null,
    repositoryId: pr.repository ? pr.repository.id : null,
    projectId: pr.repository ? pr.repository.project.id : null,
    projectName: pr.repository ? pr.repository.project.name : null,
    createdDate: pr.creationDate || null,
    closedDate: pr.closedDate || null,
    url: pr.repository
      ? `https://dev.azure.com/${org}/${pr.repository.project.name}/_git/${pr.repository.name}/pullrequest/${pr.pullRequestId}`
      : null,
    reviewers: (pr.reviewers || []).map((r) => ({
      name: r.displayName,
      vote: r.vote, // 10 approved, 5 approved w/ suggestions, 0 none, -5 waiting, -10 rejected
    })),
  };
}

/** Work items ADO itself considers linked to a PR (via its "Link work
 * item" action) — the strongest signal available, when present. */
async function fetchPrWorkItemRefs(client, pr) {
  if (!pr.projectId || !pr.repositoryId) return [];
  const url = `https://dev.azure.com/${client.org}/${pr.projectId}/_apis/git/repositories/${pr.repositoryId}/pullRequests/${pr.id}/workitems?api-version=${client.apiVersion}`;
  const res = await client.request(url, { method: 'GET' });
  return (res.value || []).map((w) => Number(w.id));
}

/** Commit messages for a PR — the fallback signal when neither the title
 * nor ADO's own linked-items list mentions a work item number. */
async function fetchPrCommits(client, pr) {
  if (!pr.projectId || !pr.repositoryId) return [];
  const url = `https://dev.azure.com/${client.org}/${pr.projectId}/_apis/git/repositories/${pr.repositoryId}/pullRequests/${pr.id}/commits?api-version=${client.apiVersion}`;
  const res = await client.request(url, { method: 'GET' });
  return (res.value || []).map((c) => c.comment || '');
}

/** Work item numbers mentioned in free text (PR titles or commit
 * messages). 6-7 digits matches this project's id range; a shorter bound
 * would false-positive on version numbers and ticket-adjacent digits. */
function extractWorkItemIds(text) {
  const matches = String(text || '').match(/\b\d{6,7}\b/g) || [];
  return matches.map(Number);
}

module.exports = {
  fetchPullRequests,
  fetchPullRequestsForIdentity,
  normalizePr,
  fetchPrWorkItemRefs,
  fetchPrCommits,
  extractWorkItemIds,
  filterPrHistoryWindow,
};
