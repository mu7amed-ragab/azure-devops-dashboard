const crypto = require('crypto');
const { AdoClient } = require('./ado/client');
const { discover } = require('./ado/discovery');
const { fetchIterationMap } = require('./ado/iterations');
const { fetchPeople } = require('./ado/people');
const { searchIdentities } = require('./ado/identityPicker');
const { statesFromEveryType } = require('./ado/states');
const { fetchWorkItemTypes, classifyByCategory, typeTracksHours } = require('./ado/workItemTypes');
const { OrgStore } = require('./orgStore');
const { rolesMapFrom, findMemberByEmail, rosterGroupsForEmail } = require('./org');
const { fetchRevisionsSince, INDEX_START_DATE, REVISION_INDEX_VERSION, changedByKey } = require('./ado/revisionIndex');
const { discoverEstimateField } = require('./ado/estimateField');
const {
  queryAssignedTree,
  queryAssignedItems,
  queryRecentlyUpdated,
  queryEverAssigned,
  hydrateWorkItemsWithRelations,
  getWorkItemUpdates,
} = require('./ado/workitems');
const { fetchPullRequests, normalizePr, filterPrHistoryWindow } = require('./ado/pullrequests');
const { attributePullRequests } = require('./ado/prAttribution');
const { normalizeTask, rollupStory, isVisibleState, visibleStateNames, stateCategoryOf } = require('./compute/rollup');
const { buildTimeline, buildDailyHoursFromIndex, buildBreakdown } = require('./compute/timeline');
const { groupItemsByIteration } = require('./compute/iterationGrouping');
const { computeCrossSprintPromotions } = require('./compute/crossSprint');
const { summarizePrRepos, prActivity, prStatusId } = require('./compute/prGroups');
const { applyTaskWrite, applyStateWrite, applyMoveToParentIteration, applyMoveChildrenToStoryIteration } = require('./ado/writeback');
const { mapWithConcurrency } = require('./util/concurrency');
const { resolveIdentitySet, primaryOnlySet } = require('./identitySet');

function patFingerprint(pat) {
  return crypto.createHash('sha256').update(pat || '').digest('hex').slice(0, 16);
}

const BOUNDARY_SEED_CONCURRENCY = 8;
// Shapes the "no estimate yet" progress curve for the cold revision-index walk
// (see _reportSharedIndexProgress): the page count at which it reaches ~63%.
const INDEX_PROGRESS_SCALE = 60;
// Below this, a walk was an incremental top-up rather than a cold rebuild, and
// its page count says nothing useful about how big this project's history is.
const INDEX_ESTIMATE_MIN_PAGES = 5;
const LONG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_ITERATION_YEAR = 2026;
// Matches the window Azure DevOps's own "Recently updated" work item page
// uses — see server/ado/workitems.js queryRecentlyUpdated.
const RECENT_WINDOW_DAYS = 30;
// searchEverAssigned's per-scope in-memory LRU — see everAssignedCache above.
const EVER_ASSIGNED_CACHE_MAX = 32;
const EVER_ASSIGNED_CACHE_TTL_MS = 60 * 1000;
const SEARCH_RESULT_CAP = 50;
// A cached dashboard older than this is served instantly but also kicks off
// a background refresh — the "stale-while-revalidate" half of person
// switching being fast: the SECOND visit to a teammate is both instant and
// self-healing, not stuck on whatever was true when they were first opened.
const STALE_AFTER_MS = 5 * 60 * 1000;
// How long a burst of writes (hours logged, state/iteration changes) is
// allowed to settle before the single resync they share actually fires.
const SELF_RESYNC_DEBOUNCE_MS = 10 * 1000;
// A wiki-listed teammate the identity picker couldn't resolve stays
// suppressed for this long before being retried — a permanently typo'd
// email shouldn't fire a live IdentityPicker call on every Team page mount.
const UNRESOLVED_TEAMMATE_SUPPRESS_MS = 10 * 60 * 1000;

// A genuinely cold person (nothing cached at all) gets a fast first pass
// over just this window before the real full sync runs — see _runSync.
// Logging hours bumps System.ChangedDate, so any item with hours logged in
// this window is inside this window's tree: today/thisWeek/last7Days come
// out of the partial payload exact, not approximate.
const PARTIAL_WINDOW_DAYS = 14;

// Sync phases, weighted to roughly track real wall-clock cost on a cold
// sync: PR attribution (2 requests per PR) and the boundary-seed fan-out
// (1 request per item) are what actually dominate, alongside the one-time
// shared revision-index rebuild (reported separately, see
// _reportSharedIndexProgress).
const SYNC_STEPS = [
  { id: 'shared', label: 'Loading project data', weight: 8 },
  { id: 'query', label: 'Finding assigned work', weight: 8 },
  { id: 'hydrate', label: 'Loading work items', weight: 20 },
  { id: 'prs', label: 'Matching pull requests', weight: 24 },
  { id: 'history', label: 'Reading hours history', weight: 30 },
  { id: 'assemble', label: 'Building the dashboard', weight: 10 },
];
const SYNC_STEP_WEIGHT_BEFORE = (() => {
  const map = new Map();
  let acc = 0;
  for (const step of SYNC_STEPS) {
    map.set(step.id, acc);
    acc += step.weight;
  }
  return map;
})();
const SYNC_STEP_LABEL = new Map(SYNC_STEPS.map((s) => [s.id, s.label]));
// The fast 14-day pass owns the first third of the bar; the full pass owns
// the rest — see the two-phase driver in _runSync.
const PARTIAL_PROGRESS_SPAN = 35;

/** Matches on uniqueName as well as id: a teammate resolved through the
 * IdentityPicker fallback (see SyncEngine._resolveTeammatesLive) can carry
 * an `originId` as its id, which never matches the localId Azure DevOps
 * stamps into System.AssignedTo — matching only on id would silently treat
 * every one of that person's work items as "not theirs". */
/**
 * 006-linked-identity-aliases: widened from "matches id or uniqueName" to
 * "matches any identity in person.identities.all" — a task or story whose
 * AssignedTo is the person's OLD (linked) identity must still count as
 * theirs (FR-007), not just one whose AssignedTo is the primary. Falls back
 * to comparing against `person` itself when `person.identities` hasn't been
 * attached (e.g. a bare {id, uniqueName} passed by an older call site),
 * which reproduces the pre-widening single-identity behaviour exactly.
 */
function isPerson(identity, person) {
  if (!identity || !person) return false;
  const candidates = (person.identities && person.identities.all) || [person];
  return candidates.some(
    (p) =>
      (identity.id && p.id && identity.id === p.id) ||
      !!(p.uniqueName && identity.uniqueName && identity.uniqueName.toLowerCase() === p.uniqueName.toLowerCase())
  );
}

/**
 * 006-linked-identity-aliases (FR-008): true only when `identity` is the
 * person's PRIMARY (signed-in) identity — never a linked one. This is the
 * comparison behind the `editable` flag on every story/task/unparented item
 * (a UI courtesy, gating which controls are even offered), kept
 * deliberately separate from `isPerson` above (which decides what counts as
 * "this person's work" for rollups and is correctly widened to the whole
 * set). `assertAssignedTo` in ado/writeback.js performs the same
 * primary-only comparison server-side and is the real enforcement; this
 * only has to agree with it closely enough that the UI doesn't offer a
 * control the server will refuse.
 */
function isPrimary(identity, person) {
  if (!identity || !person) return false;
  const primary = (person.identities && person.identities.primary) || person;
  return (
    (identity.id && primary.id && identity.id === primary.id) ||
    !!(primary.uniqueName && identity.uniqueName && identity.uniqueName.toLowerCase() === primary.uniqueName.toLowerCase())
  );
}

/**
 * 007-all-assigned-types: whether this task/item's TYPE carries Completed
 * Work, so the hours editor is only offered where an hours write can land. A
 * UI courtesy only — applyTaskWrite refuses the write itself with
 * TYPE_NO_HOURS (research.md R5). Set on tasks and unparented items, never on
 * stories, whose hours are a rollup with no editor.
 */
function withHoursCapability(item, types) {
  item.hoursEditable = typeTracksHours(item.type, types);
  return item;
}

function byChangedDateDesc(a, b) {
  const da = a.changedDate ? new Date(a.changedDate).getTime() : 0;
  const db = b.changedDate ? new Date(b.changedDate).getTime() : 0;
  return db - da;
}

/** Groups attributed PRs by the story (or unparented item) they resolved
 * to — `attribution` is the Map<prId, {story, linkedItems}> from
 * attributePullRequests. Shared by the inline partial-pass attribution and
 * the background full-history fill (_fillStoryPrs) below. */
function buildPrsByStoryId(prs, attribution) {
  const prsByStoryId = new Map();
  for (const pr of prs) {
    const attr = attribution.get(pr.id);
    if (!attr || !attr.story) continue;
    if (!prsByStoryId.has(attr.story.id)) prsByStoryId.set(attr.story.id, []);
    prsByStoryId.get(attr.story.id).push(pr);
  }
  return prsByStoryId;
}

/** Reads back whatever PRs a previous cached dashboard already had
 * attached to each story/unparented item — used as a stand-in while a
 * fresh background attribution fill is in flight, so a routine resync
 * doesn't flash every story's PR section empty for the few seconds the
 * fill takes (see _fillStoryPrs). */
function collectPrsByItemId(dashboard) {
  const map = new Map();
  if (!dashboard) return map;
  const record = (item) => {
    if (item && item.pullRequests && item.pullRequests.length > 0) map.set(item.id, item.pullRequests);
  };
  for (const s of dashboard.stories || []) record(s);
  for (const g of dashboard.groups || []) {
    for (const s of g.stories || []) record(s);
    for (const u of g.unparentedItems || []) record(u);
  }
  return map;
}

/** Patches attributed PRs onto every story/unparented item across the
 * dashboard's several nested locations (top-level `stories`, each
 * iteration group's `stories`/`unparentedItems`, and `recentItems`) — a
 * cache round-trip through JSON breaks any object-identity sharing these
 * had at build time, so each location needs its own patch. Items with no
 * entry in `prsByStoryId` are left untouched: a subtask's `pullRequests` is
 * always `[]` by design (attribution resolves to stories, never tasks) and
 * must not be touched here. */
function applyPrsToItem(item, prsByStoryId) {
  const prs = prsByStoryId.get(item.id);
  if (!prs) return;
  item.pullRequests = prs;
  if ('repository' in item && prs.length > 0) item.repository = prs[0].repository;
}

function applyStoryPrsToDashboard(dashboard, prsByStoryId) {
  for (const s of dashboard.stories || []) applyPrsToItem(s, prsByStoryId);
  for (const g of dashboard.groups || []) {
    for (const s of g.stories || []) applyPrsToItem(s, prsByStoryId);
    for (const u of g.unparentedItems || []) applyPrsToItem(u, prsByStoryId);
    // A promoted cross-sprint entry (US2) is a Task, whose pullRequests is
    // always [] by the same rule applyPrsToItem's own comment states
    // (attribution resolves to stories, never tasks) — traversed here purely
    // so a promoted rendering can never silently drift from its nested twin
    // if that rule ever changes, not because it does anything today.
    for (const c of g.crossSprintItems || []) applyPrsToItem(c, prsByStoryId);
  }
  for (const entry of dashboard.recentItems || []) {
    applyPrsToItem(entry.kind === 'story' ? entry.story : entry.task, prsByStoryId);
  }
}

/** Keeps items with an iteration that resolves to MIN_ITERATION_YEAR or
 * later. Unresolvable paths pass through here and are dropped later by
 * groupItemsByIteration, which is the single place that decision lives. */
function isRecentEnoughIteration(iterationPath, iterationMap) {
  if (!iterationPath) return true;
  const meta = iterationMap.get(iterationPath);
  if (!meta || !meta.startDate) return true;
  return new Date(meta.startDate).getFullYear() >= MIN_ITERATION_YEAR;
}

function stripKind({ __kind, ...rest }) {
  return rest;
}

/** Groups visible stories AND unparented tasks/bugs into the same sprint
 * buckets (both carry `iterationPath` and `changedDate`, so one grouping
 * pass handles both), tagged so they land in separate arrays afterward.
 *
 * Also emits `crossSprintItems` (005-search-history-sprint-placement, US2):
 * a child task whose own sprint differs from its parent story's is promoted
 * into a standalone entry in ITS OWN sprint's group, carrying a `parentRef`
 * back to the story it isn't shown under. The promoted list is computed and
 * appended AFTER `hours` above is reduced over stories+unparentedItems only —
 * this ordering is load-bearing: a promoted child's hours are already
 * counted inside its parent story's rollup, in the PARENT's own group, so
 * adding them again here would inflate this sprint's total (FR-015, the
 * property data-model.md calls the single most breakable one in this
 * change). A promotion target sprint that has no story/unparented item of
 * its own still gets a group created for it (zero hours, since — again — a
 * promoted child contributes nothing to any group's hours), so the sprint
 * shows up in the payload at all. */
function groupByIteration(stories, unparentedItems, iterationMap) {
  const tagged = [
    ...stories.map((s) => ({ ...s, __kind: 'story' })),
    ...unparentedItems.map((u) => ({ ...u, __kind: 'unparented' })),
  ];
  const { groups, droppedCount } = groupItemsByIteration(tagged, iterationMap, byChangedDateDesc);

  const shaped = groups.map((g) => {
    const groupStories = g.items.filter((i) => i.__kind === 'story').map(stripKind);
    const groupUnparented = g.items.filter((i) => i.__kind === 'unparented').map(stripKind);
    const hours = [...groupStories, ...groupUnparented].reduce(
      (acc, i) => {
        acc.estimated += i.hours.estimated;
        acc.completed += i.hours.completed;
        acc.remaining += i.hours.remaining;
        return acc;
      },
      { estimated: 0, completed: 0, remaining: 0 }
    );
    return {
      iterationPath: g.iterationPath,
      iterationName: g.iterationName,
      startDate: g.startDate,
      finishDate: g.finishDate,
      isLatest: g.isLatest,
      hours,
      stories: groupStories,
      unparentedItems: groupUnparented,
      crossSprintItems: [], // always an array — data-model.md §3
    };
  });

  const isPromotableIteration = (path) => {
    const meta = iterationMap.get(path);
    return !!(meta && meta.startDate) && isRecentEnoughIteration(path, iterationMap);
  };
  const promotions = computeCrossSprintPromotions(stories, isPromotableIteration);

  if (promotions.length > 0) {
    const promotedItems = promotions.map((p) => ({ ...p.item, __kind: 'promoted' }));
    // Reuse the same grouping engine for consistent sprint metadata
    // (name/dates) and ordering — its own "No sprint" bucket is never
    // reached here, since isPromotableIteration already required a
    // resolved, dated sprint (data-model.md §3's "resolves to a real
    // sprint" clause).
    const { groups: promotedGroups } = groupItemsByIteration(promotedItems, iterationMap, byChangedDateDesc);
    const shapedByPath = new Map(shaped.map((g) => [g.iterationPath, g]));

    for (const pg of promotedGroups) {
      const items = pg.items.map(stripKind);
      const existing = shapedByPath.get(pg.iterationPath);
      if (existing) {
        existing.crossSprintItems = items;
      } else {
        const newGroup = {
          iterationPath: pg.iterationPath,
          iterationName: pg.iterationName,
          startDate: pg.startDate,
          finishDate: pg.finishDate,
          isLatest: false, // isLatest re-decided below over the merged set
          hours: { estimated: 0, completed: 0, remaining: 0 },
          stories: [],
          unparentedItems: [],
          crossSprintItems: items,
        };
        shaped.push(newGroup);
        shapedByPath.set(pg.iterationPath, newGroup);
      }
    }

    // A newly created group can be the newest sprint, so isLatest has to be
    // redecided over the full merged set — same rule groupItemsByIteration
    // itself uses (real start date descending).
    shaped.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
    for (const g of shaped) g.isLatest = false;
    if (shaped.length > 0 && shaped[0].startDate) shaped[0].isLatest = true;
  }

  return { groups: shaped, droppedCount };
}

/**
 * Orchestrates sync cycles. Holds the shared, person-independent caches
 * (identity, iteration map, people list, work item revision history) and
 * produces one dashboard payload per person on demand.
 */
class SyncEngine {
  /**
   * @param {object} config this project's scope config (server/scopes.js)
   * @param {import('./cache').Cache} cache this project's own cache directory —
   *   where everything project-scoped lands, which is why no cache key in this
   *   file carries a project prefix.
   * @param {import('./cache').Cache} [orgCache] the cache shared across every
   *   project (`.cache/_org/`). Used for exactly one thing: PR attribution
   *   candidates, which are keyed by PR id and describe the PR rather than the
   *   viewer — and pull requests are org-scoped in this app on purpose (see
   *   ado/pullrequests.js). Defaults to `cache` so a caller that doesn't care
   *   (a test) still works, just without the cross-project sharing.
   */
  constructor(config, cache, orgCache) {
    this.config = config;
    this.cache = cache;
    this.orgCache = orgCache || cache;
    this.client = new AdoClient(config);
    this.discovery = null;
    this.iterationMap = null;
    this.people = null;
    // This project's own process template: which work item types exist and
    // which workflow states each of them has. Both are discovered from ADO
    // per project (ensureTypes/ensureStates) — nothing about the Agile
    // template is assumed anywhere, so a Scrum/Basic/CMMI/custom project
    // works off its own names. One engine per project (server/scopes.js)
    // is what guarantees these can never hold another project's answer.
    this.types = null;
    this.typesInFlight = null; // Promise, dedupes concurrent ensureTypes
    this.states = null;
    this.roles = null; // Map<email, {role, team}>, derived from orgStore — see ensureRoles
    this.orgStore = new OrgStore(config.orgDataFile);
    this.unresolvedTeammates = new Map(); // email -> ts, suppresses repeat IdentityPicker lookups
    // Legacy per-item revision cache. No longer populated by a full-tree
    // fan-out (that was the ~85s-per-person bottleneck) — it now only holds
    // items individually fetched for boundary-seeding the shared index, or
    // items invalidated by a write. Immutable and keyed by work item id, so
    // it is shared across every person.
    this.updatesCache = this.cache.get('workItemUpdates') || {};
    // The shared revision index: Map<workItemId, [{rev, completedWork, changedDate, changedBy}]>,
    // covering every work item in the project — built once, not per person.
    // See server/ado/revisionIndex.js. A cached index built under an older
    // REVISION_INDEX_VERSION is discarded rather than read as-is — its
    // entries are missing fields the current code depends on (e.g.
    // `changedBy`, added in v2 for per-person hours attribution) — forcing
    // one rebuild from INDEX_START_DATE rather than silently mixing
    // old-shaped and new-shaped entries.
    const cachedIndex = this.cache.get('revisionIndex');
    const cachedIndexIsCurrent = cachedIndex && cachedIndex.version === REVISION_INDEX_VERSION;
    this.revisionIndex = new Map(cachedIndexIsCurrent ? cachedIndex.entries : []);
    this.revisionWatermark = cachedIndexIsCurrent ? cachedIndex.watermark : INDEX_START_DATE;
    // How many pages this project's last full walk took — the denominator for
    // the indexing progress bar, learned per project rather than hardcoded.
    // Deliberately read even from an index whose VERSION is stale: the entries
    // are unusable then, but "this project's history is about N pages long" is
    // still true, and it is exactly the rebuild that follows which needs it.
    this.indexPageEstimate = (cachedIndex && cachedIndex.pages) || null;
    this.revisionIndexReady = null; // Promise, set by ensureRevisionIndex()
    // This project's own story-level estimate field (StoryPoints/Effort/
    // Size — server/ado/estimateField.js), or null on a project with none.
    // Discovered once per process, cached alongside `types`/`states` rather
    // than on disk: unlike those, it must be known BEFORE the revision index
    // can be walked (it's part of REVISION_FIELDS), so there is nothing
    // useful to persist independently of the index itself.
    this.estimateField = undefined; // undefined = not yet discovered; null = discovered-as-absent
    this.estimateFieldReady = null; // Promise, dedupes concurrent discovery
    this.boundarySeeded = new Set(); // ids already checked/seeded this run
    this.inFlight = new Map(); // identityId -> Promise, dedupes concurrent syncs
    // personId -> Promise, dedupes concurrent background PR-attribution
    // fills (see _fillStoryPrs) so a resync mid-fill doesn't double it up.
    this.prFillInFlight = new Map();
    // Per-person sync progress, polled via GET /api/sync/progress — see
    // _setStep. progress: personId -> {phase, label, pct, partial, startedAt,
    // updatedAt}; progressScale: personId -> {base, span}, how a single
    // sync PASS's own 0-100 maps onto the overall bar (the two-phase driver
    // gives the partial pass the first PARTIAL_PROGRESS_SPAN of it).
    this.progress = new Map();
    this.progressScale = new Map();
    this.listeners = new Set();
    this.resyncTimers = new Map(); // personId -> Timeout, debounces post-write resyncs per person
    // True once a call under this scope's READ token comes back 401 — the
    // token itself is expired/revoked, not just missing one scope. That token
    // is the service ADO_PAT when it can read this project, otherwise the PAT
    // of whoever opened the project (see server/scopes.js), and either way
    // every person looking at this project is affected at once, so it's
    // surfaced via /api/auth/me as a banner rather than a per-person error.
    // Reactive only — see the PAT-expiry plan for why a proactive "expires in
    // N days" warning isn't possible (querying a PAT's own expiry needs Token
    // Administration scope, which this app deliberately never requests).
    this.readTokenInvalid = false;
    // personId -> the bare-401 Error from that person's own most recent
    // failed sync (see syncPerson below) — set only when the sync was for
    // that person's OWN dashboard (isSelf), so a route handler can turn a
    // dead-token failure that already happened (fire-and-forget, so it
    // can't be awaited on the request that triggered it) into a clear
    // sign-out on the NEXT request for that same person, instead of an
    // indefinite 202/stale-cache loop. Cleared on that person's next
    // successful sync. Deliberately keyed by person, unlike
    // readTokenInvalid above: a teammate's sync failing this way must never
    // be mistaken for the viewing caller's own token being dead.
    this.selfSyncErrors = new Map();
    // Per-scope in-memory LRU for searchEverAssigned, keyed `person.id + ' '
    // + normalizedQuery` — 32 entries, 60s TTL (research.md R4). Deliberately
    // NOT `.cache/`: a transient search result has no place in a directory
    // whose whole contract is "disposable, and deleting it forces a correct
    // full resync" — this covers only the real repetition (backspacing a
    // character) and evaporates on restart or scope eviction.
    this.everAssignedCache = new Map();
  }

  /** Swaps the client every shared read runs under — used when a scope's read
   * token turns out to be dead and a live one is available (see
   * server/scopes.js). Everything derived from the old token is dropped so it
   * is re-read under the new one; orgStore.client matters especially, since
   * it's what org-chart WRITES go through and it's captured at load() time. */
  setClient(client) {
    this.client = client;
    this.discovery = null;
    this.roles = null;
    // Process discovery is read-token-dependent too: a token that couldn't see
    // work item type categories fell back to stock Agile names, and the new
    // token may well be able to read the real ones.
    this.types = null;
    this.typesInFlight = null;
    this.states = null;
    this.estimateField = undefined;
    this.estimateFieldReady = null;
    this.readTokenInvalid = false;
    // A recorded self-sync error names the OLD token as the culprit — once
    // the client has been swapped for a new one (a re-election, see
    // server/scopes.js), that record no longer describes reality and must
    // not go on 401-ing every request for whoever it was keyed to. Without
    // this, a person who re-signs in with a brand-new valid PAT after their
    // old one died would be bounced straight back to /login by a stale
    // entry that can otherwise only ever be cleared by a SUCCESSFUL sync —
    // which the priorSelfError short-circuit in server/index.js prevents
    // from ever running again.
    this.selfSyncErrors = new Map();
    if (this.orgStore) this.orgStore.client = client;
  }

  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify(payload) {
    for (const fn of this.listeners) {
      try {
        fn(payload);
      } catch (err) {
        // listener errors must not break the sync loop
      }
    }
  }

  async ensureDiscovery(force = false) {
    if (force) this.discovery = null;
    if (!this.discovery) {
      const cached = force ? null : this.cache.get('discovery');
      const fp = patFingerprint(this.config.pat);
      const isStale =
        !cached ||
        Date.now() - new Date(cached.discoveredAt).getTime() > LONG_CACHE_TTL_MS ||
        cached.patFingerprint !== fp;
      // The Blocked-signal half of discovery probes work item types, so it needs
      // THIS project's own type names — a Scrum project has no 'User Story' and
      // a Basic one has no 'Bug' to probe.
      const data = isStale
        ? await discover(this.client, await this._blockedSignalTypeOptions())
        : cached;
      if (isStale) {
        this.cache.set('discovery', { ...data, patFingerprint: fp });
      }
      this.discovery = data;
    }
    return this.discovery;
  }

  async ensureIterationMap(force = false) {
    if (force) this.iterationMap = null;
    if (!this.iterationMap) {
      const cached = force ? null : this.cache.get('iterationMap');
      const isStale = !cached || Date.now() - cached.fetchedAt > LONG_CACHE_TTL_MS;
      if (isStale) {
        const map = await fetchIterationMap(this.client);
        this.cache.set('iterationMap', { fetchedAt: Date.now(), entries: [...map.entries()] });
        this.iterationMap = map;
      } else {
        this.iterationMap = new Map(cached.entries);
      }
    }
    return this.iterationMap;
  }

  async ensurePeople(force = false) {
    if (force) this.people = null;
    if (!this.people) {
      const cached = force ? null : this.cache.get('people');
      const isStale = !cached || Date.now() - cached.fetchedAt > LONG_CACHE_TTL_MS;
      if (isStale) {
        const people = await fetchPeople(this.client);
        this.cache.set('people', { fetchedAt: Date.now(), people });
        this.people = people;
      } else {
        this.people = cached.people;
      }
    }
    return this.people;
  }

  /**
   * 006-linked-identity-aliases: `primary`'s IdentitySet, cached per PRIMARY
   * id for 24h in this scope's own disk cache — same TTL and staleness
   * pattern as `ensureDiscovery` above, and for the same reason (retired
   * identities are historical; a link discovered once stays valid without
   * live revalidation, per research.md). One entry per primary id, so this
   * naturally holds one cached set per person who has signed into this
   * project, not one set per scope.
   *
   * Never called from the sign-in path itself (FR-012) — callers that need
   * "this session's identity set, or the primary alone if it isn't ready
   * yet" should read `resolvePerson`'s result instead of awaiting this
   * directly on a hot path.
   */
  async ensureIdentitySet(primary, force = false) {
    if (!primary || !primary.id) return primaryOnlySet(primary || { id: null, uniqueName: null });
    const cacheKey = `identitySet-${primary.id}`;
    const cached = force ? null : this.cache.get(cacheKey);
    const isStale = !cached || Date.now() - new Date(cached.resolvedAt).getTime() > LONG_CACHE_TTL_MS;
    if (!isStale) {
      return { ...cached, ids: new Set(cached.ids), keys: new Set(cached.keys) };
    }
    const people = await this.ensurePeople().catch(() => []);
    const set = await resolveIdentitySet(this.client, primary, people);
    // Sets don't survive JSON — persist the plain arrays and rebuild the Set
    // views on every read (see the isStale===false branch above).
    this.cache.set(cacheKey, { ...set, ids: [...set.ids], keys: [...set.keys] });
    return set;
  }

  /**
   * 006-linked-identity-aliases (T032): `ensureIdentitySet` by email rather
   * than by a caller-supplied `{id, uniqueName}` — for callers that only
   * have an email, like the Scrum roster (server/scrum.js), which comes
   * from the org chart wiki page and carries no ADO identity id of its own.
   * Resolves the email against this scope's people roster first (so the
   * result shares the same 24h cache entry `resolvePerson` would produce
   * for the same person), and falls back to a primary-only, non-degraded
   * set keyed on the bare email when no ADO identity is found for it — the
   * roster can legitimately contain an email ADO doesn't resolve (a typo,
   * someone who left), and that must not be treated as a discovery failure.
   */
  async getIdentitySetForEmail(email) {
    if (!email) return primaryOnlySet({ id: null, uniqueName: email });
    const people = await this.ensurePeople().catch(() => []);
    const match = people.find((p) => p.uniqueName && p.uniqueName.toLowerCase() === String(email).toLowerCase());
    if (!match) return primaryOnlySet({ id: null, uniqueName: email });
    return this.ensureIdentitySet(match).catch(() => primaryOnlySet(match, { degraded: true }));
  }

  /** Merges people found via the live directory search into the in-memory
   * list (not the 24h disk cache — these are one-off lookups, not part of
   * the periodic snapshot) so `resolvePerson` can find them by id right
   * after a search, without waiting for the next people-cache refresh. */
  registerPeople(list) {
    const byId = new Map(this.people.map((p) => [p.id, p]));
    for (const p of list) byId.set(p.id, p);
    this.people = [...byId.values()];
  }

  /**
   * GET /api/workitems/search's engine: work items in THIS project that
   * `person` was ever assigned and is not assigned now, matching `q`. See
   * contracts/search-workitems.md and data-model.md §4.
   *
   * Read-only, and adds no write path — `assertAssignedTo` (ado/writeback.js)
   * already refuses a write to any item whose real AssignedTo isn't the
   * caller, so a past-owned result fails that check by definition; nothing
   * here needs to duplicate that enforcement.
   */
  async searchEverAssigned(person, q) {
    const normalizedQuery = String(q || '').trim();
    if (normalizedQuery.length < 2) return { results: [], truncated: false, query: '' };

    const cacheKey = `${person.id} ${normalizedQuery.toLowerCase()}`;
    const cached = this.everAssignedCache.get(cacheKey);
    if (cached && Date.now() - cached.at < EVER_ASSIGNED_CACHE_TTL_MS) {
      // Refresh recency for the LRU eviction below.
      this.everAssignedCache.delete(cacheKey);
      this.everAssignedCache.set(cacheKey, cached);
      return cached.value;
    }

    const [states, types] = await Promise.all([this.ensureStates(), this.ensureTypes()]);
    // Widened to the whole identity set (006-linked-identity-aliases): EVER
    // is an OR-group over every identity, and the "not currently assigned"
    // exclusion is an AND-group over all of them too — an item merely moved
    // from the old identity to the new one must not surface here as
    // "past-owned" when it is in fact current (see ado/workitems.js
    // queryEverAssigned's own comment).
    // Every type (007-all-assigned-types); `types` is still needed below for
    // each result's hoursEditable.
    const { ids, truncated } = await queryEverAssigned(this.client, person, {
      q: normalizedQuery,
      top: SEARCH_RESULT_CAP,
    });

    const raw = await hydrateWorkItemsWithRelations(this.client, ids);
    // Every hydrated item is re-checked for System.TeamProject before it
    // becomes a Task — /wit/workitemsbatch returns anything the caller's
    // token can see even through a project-scoped URL (the exact property
    // ado/sprintItems.js's own filter exists for, and ado/prAttribution.js
    // uses on purpose the other way). See data-model.md §6.6.
    const inProject = raw.filter((wi) => (wi.fields || {})['System.TeamProject'] === this.config.project);

    const items = inProject.map((wi) => {
      const item = withHoursCapability(normalizeTask(wi, null, states), types);
      item.pullRequests = [];
      return { wi, item };
    });

    // One batch fetch for every distinct parent id, so a result's ParentRef
    // (data-model.md §1) carries the parent's own title/type/iterationPath
    // without an N+1 fan-out. Same TeamProject re-check applies.
    const parentIds = [...new Set(items.map(({ item }) => item.parentId).filter((id) => id != null))];
    const rawParents = parentIds.length > 0 ? await hydrateWorkItemsWithRelations(this.client, parentIds) : [];
    const parentById = new Map(
      rawParents
        .filter((p) => (p.fields || {})['System.TeamProject'] === this.config.project)
        .map((p) => [
          p.id,
          {
            id: p.id,
            title: (p.fields || {})['System.Title'] || `#${p.id}`,
            type: (p.fields || {})['System.WorkItemType'] || 'Unknown',
            iterationPath: (p.fields || {})['System.IterationPath'] || null,
          },
        ])
    );

    const results = items.map(({ wi, item }) => {
      item.parentRef = item.parentId != null ? parentById.get(item.parentId) || null : null;
      const assignedTo = (wi.fields || {})['System.AssignedTo'];
      return {
        item,
        currentAssignee: assignedTo ? assignedTo.displayName : null,
        lastAssignedToPerson: null,
      };
    });

    const value = { results, truncated, query: normalizedQuery };

    this.everAssignedCache.set(cacheKey, { at: Date.now(), value });
    if (this.everAssignedCache.size > EVER_ASSIGNED_CACHE_MAX) {
      const oldestKey = this.everAssignedCache.keys().next().value;
      this.everAssignedCache.delete(oldestKey);
    }

    return value;
  }

  /** Live directory search for someone missing from the cached people list
   * (no team, no recent assigned work). Results are registered so the
   * person becomes immediately selectable. */
  async searchPeople(query) {
    await this.ensurePeople();
    const results = await searchIdentities(this.client, query);
    this.registerPeople(results);
    return results;
  }

  /**
   * Which work item types THIS project's process template uses, by role
   * (requirement/task/bug) — discovered from ADO's process-independent type
   * categories, never hardcoded, so a Scrum project gets 'Product Backlog
   * Item' where an Agile one gets 'User Story'. See ado/workItemTypes.js.
   *
   * Also carries `everyType` — every type the project has, with its states and
   * whether it tracks hours (007-all-assigned-types; see fetchEveryType). The
   * key is `types-v2` so a cached answer without `everyType` is never reused.
   *
   * Cached in this project's own cache directory (`.cache/<slug>-<id8>/types-v2`),
   * which is what keeps two projects on two different templates from ever
   * seeing each other's answer — the key needs no project prefix because the
   * directory IS the scope (see server/scopes.js).
   */
  async ensureTypes(force = false) {
    if (force) {
      this.types = null;
      this.typesInFlight = null;
    }
    if (this.types) return this.types;
    // Deduped: ensureStates and ensureDiscovery both need this, and _runSyncPass
    // starts them in the same Promise.all — without this they'd each pay for the
    // categories call.
    if (this.typesInFlight) return this.typesInFlight;

    this.typesInFlight = (async () => {
      const cached = force ? null : this.cache.get('types-v2');
      const isStale = !cached || Date.now() - cached.fetchedAt > LONG_CACHE_TTL_MS;
      if (isStale) {
        const types = await fetchWorkItemTypes(this.client);
        this.cache.set('types-v2', { fetchedAt: Date.now(), types });
        this.types = types;
      } else {
        this.types = cached.types;
      }
      return this.types;
    })().finally(() => {
      this.typesInFlight = null;
    });
    return this.typesInFlight;
  }

  /** Type names for detectBlockedSignal. Failing softly matters here: a
   * Blocked-signal probe is a nice-to-have, and it must never be the thing that
   * stops a dashboard from loading — so an unavailable type list falls through
   * to the probe's own stock-Agile default rather than propagating. */
  async _blockedSignalTypeOptions() {
    try {
      const types = await this.ensureTypes();
      return { types: types.allTypes, taskTypes: types.taskTypes };
    } catch (err) {
      return {};
    }
  }

  /**
   * The real per-type workflow states for this project, keyed by type name.
   * The type list is itself discovered (ensureTypes), so this asks about the
   * types that exist here rather than a fixed Agile triple — and every
   * consumer (state picker, visible-state filtering, the automatic transitions
   * in ado/writeback.js) branches on the `category` ADO returns alongside each
   * state, never on its name.
   *
   * Covers EVERY type the project has, not only requirement/task/bug
   * (007-all-assigned-types, research.md R4): any type can now be assigned
   * work on the dashboard, and an unknown workflow would make a closed item of
   * that type look visible. Keyed `states-v2` so a three-family map is never
   * reused.
   */
  async ensureStates(force = false) {
    if (force) this.states = null;
    if (!this.states) {
      const cached = force ? null : this.cache.get('states-v2');
      const isStale = !cached || Date.now() - cached.fetchedAt > LONG_CACHE_TTL_MS;
      if (isStale) {
        const types = await this.ensureTypes(force);
        const states = await statesFromEveryType(this.client, types.everyType || {}, types.allTypes);
        this.cache.set('states-v2', { fetchedAt: Date.now(), states });
        this.states = states;
      } else {
        this.states = cached.states;
      }
    }
    return this.states;
  }

  /** This project's own story-level estimate field (FR-013a) — discovered
   * from its requirement type(s), never assumed. `null` means genuinely
   * absent (e.g. a Basic-process project), not "not yet checked" — callers
   * (velocity) must then report the unit as unavailable rather than zero. */
  async ensureEstimateField() {
    if (this.estimateField !== undefined) return this.estimateField;
    if (this.estimateFieldReady) return this.estimateFieldReady;
    this.estimateFieldReady = (async () => {
      const { requirementTypes } = await this.ensureTypes();
      const result = await discoverEstimateField(this.client, requirementTypes);
      this.estimateField = result; // {field, label} | null
      return result;
    })().finally(() => {
      this.estimateFieldReady = null;
    });
    return this.estimateFieldReady;
  }

  /** Forces the shared, project-wide caches (discovery, iterations, people,
   * states, roles) to refetch regardless of their normal TTLs — the "Reload
   * All Data" button's answer to sprints/teammates that would otherwise
   * stay invisible for up to LONG_CACHE_TTL_MS (24h). Deliberately does NOT
   * touch the revision index — that already refreshes incrementally on
   * every sync (see ensureRevisionIndex), and resetting it would force an
   * expensive full re-page of the project's revision feed for no benefit. */
  async refreshShared() {
    await Promise.all([
      this.ensureDiscovery(true),
      this.ensureIterationMap(true),
      this.ensurePeople(true),
      // Forces ensureTypes(true) too — the type list is what the state
      // fetch is driven from, so refreshing states re-discovers types.
      this.ensureStates(true),
      this.ensureRoles(),
    ]);
  }

  /** The role/team map, derived from the org chart (server/orgStore.js —
   * teams/members/reporting-lines edited from the Team page's "Manage team"
   * button). The chart lives entirely in memory once loaded (a single
   * process is the only writer, and every admin write mutates it directly),
   * so this only does real work once per process; `force`/`invalidateRoles`
   * exist for the one case that changes it out from under the cached map —
   * a write via the admin API — so that request's own response reflects it
   * immediately rather than needing a second round trip. */
  async ensureRoles(force = false) {
    if (force) this.roles = null;
    if (this.roles) return this.roles;
    await this.orgStore.load(this.client, this.config);
    this.roles = rolesMapFrom(this.orgStore.getStore());
    return this.roles;
  }

  /** Called after every org-chart write (server/index.js's /api/org routes)
   * so the next role/team read reflects it without waiting for anything. */
  invalidateRoles() {
    this.roles = null;
  }

  /** A given email's own entry in the roles map, or null if they're not
   * listed. Takes the email explicitly rather than reading the service PAT
   * owner's, since under multi-user auth "who's asking" is the session's
   * own identity, not the service PAT owner's. */
  async getRoleEntryFor(uniqueName, force = false) {
    const roles = await this.ensureRoles(force);
    if (!uniqueName) return null;
    return roles.get(uniqueName.toLowerCase()) || null;
  }

  /** `uniqueName`'s role ('lead' | 'principal' | null). */
  async getRoleFor(uniqueName, force = false) {
    const entry = await this.getRoleEntryFor(uniqueName, force);
    return entry ? entry.role : null;
  }

  /** Refreshes the shared revision index from wherever it last left off.
   * Steady-state cost is ~1 request (nothing new happened); a cold start
   * pages the whole project once (~78s the first time, then persisted to
   * disk so a restart resumes from the watermark instead of redoing it).
   * Concurrent callers share one in-flight refresh — during a cold rebuild
   * every person currently syncing shares the same page-progress signal,
   * since this work isn't attributable to any one of them. */
  async ensureRevisionIndex() {
    if (!this.revisionIndexReady) {
      // No .catch(() => null) here on purpose: ensureEstimateField() only
      // ever RESOLVES to null for the genuine "this project has no estimate
      // field" case (see discoverEstimateField) — a transient discovery
      // failure REJECTS instead, and swallowing that into null would bake a
      // wrong estimate:null onto every item in this pass and advance the
      // watermark past it, permanently. Letting it reject instead fails
      // this whole sync pass (this method is awaited alongside
      // ensureDiscovery/ensureStates/ensureTypes in _runSyncPass's own
      // Promise.all, none of which are individually caught either — a
      // transient failure in any one of them already fails the pass the
      // same way today). There is no retry loop around a failed pass; the
      // failure surfaces to the caller (e.g. GET /api/dashboard) exactly
      // like those other shared-resource failures do, and the NEXT
      // independent sync attempt tries again from scratch — nothing here
      // bakes a wrong answer into the persisted index in the meantime,
      // which is the actual property this exists to protect.
      this.revisionIndexReady = this.ensureEstimateField()
        .then((estimateField) =>
          fetchRevisionsSince(
            this.client,
            this.revisionWatermark,
            this.revisionIndex,
            (pages) => this._reportSharedIndexProgress(pages),
            estimateField && estimateField.field
          )
        )
        .then(({ watermark, pages }) => {
          this.revisionWatermark = watermark;
          // Remember how long the walk actually was, but only when it was long
          // enough to mean something. A steady-state refresh is 1-2 pages;
          // persisting THAT as the estimate would make the next cold rebuild
          // report "page 40 of ~2".
          if (pages >= INDEX_ESTIMATE_MIN_PAGES) this.indexPageEstimate = pages;
          this.cache.set('revisionIndex', {
            version: REVISION_INDEX_VERSION,
            watermark,
            entries: [...this.revisionIndex.entries()],
            // Persisted so a cache-version bump or a cleared index still gets a
            // real total on its next cold walk instead of falling back to the
            // no-total mode.
            pages: this.indexPageEstimate || null,
          });
          return pages;
        })
        .finally(() => {
          this.revisionIndexReady = null;
        });
    }
    return this.revisionIndexReady;
  }

  /**
   * The one-time cold revision-index rebuild isn't attributable to any single
   * person, so every person currently syncing shares this progress signal —
   * reported inside the 'shared' step, which every sync pass starts with.
   *
   * How many pages that takes is a property of the PROJECT's history, and
   * nothing knows it until the walk finishes. This used to divide by a
   * hardcoded 95 (measured once, on one project) and print "page N of ~95",
   * which on any larger project produced a bar pinned at 95% and a label
   * reading "page 240 of ~95" — i.e. it looked stuck and it was visibly wrong.
   *
   * So there are two modes, and neither invents a number:
   *  - No estimate yet (the genuinely first cold walk of this project): report
   *    the page count with NO total, and drive the bar off a curve that keeps
   *    advancing however long the walk runs — asymptotic, so it slows down
   *    rather than stalling, and never reaches 1.0.
   *  - An estimate exists (this project has completed a walk before; the count
   *    is persisted alongside the index): use it. If the walk passes it anyway
   *    — history grew, or the window moved — the estimate is raised rather than
   *    clamped, so the label stays truthful and the bar stays in motion.
   */
  _reportSharedIndexProgress(pages) {
    let detail;
    let fraction;
    if (this.indexPageEstimate) {
      if (pages > this.indexPageEstimate) {
        // Overshot a learned estimate: widen it instead of pinning at the cap.
        this.indexPageEstimate = Math.ceil(pages * 1.15);
      }
      fraction = Math.min(0.95, pages / this.indexPageEstimate);
      detail = `Indexing project history — page ${pages} of ~${this.indexPageEstimate}`;
    } else {
      // 1 - e^(-n/60): ~0.63 at 60 pages, ~0.86 at 120, ~0.95 at 180. Always
      // moving, never claiming to be finished.
      fraction = Math.min(0.95, 1 - Math.exp(-pages / INDEX_PROGRESS_SCALE));
      detail = `Indexing project history — page ${pages}`;
    }
    for (const personId of this.progress.keys()) {
      this._setStep(personId, 'shared', fraction, detail);
    }
  }

  /** Every indexed revision of one work item, oldest first — the raw v3
   * entries (server/ado/revisionIndex.js). Compute modules (velocity,
   * burndown, scope-change, impediments) read the index through these three
   * accessors rather than reaching into `this.revisionIndex`'s Map shape
   * directly, so the internal representation can change without touching
   * every consumer. */
  getRevisionsFor(id) {
    return this.revisionIndex.get(id) || [];
  }

  /** `field`'s value as of the latest revision at or before `date` (ISO
   * string) — "what was this field at time T". Returns null when the item
   * has no revision that early, or the field was never recorded. */
  getFieldAt(id, field, date) {
    const revs = this.getRevisionsFor(id);
    let value = null;
    for (const r of revs) {
      if (r.changedDate && r.changedDate > date) break;
      if (field in r) value = r[field];
    }
    return value === undefined ? null : value;
  }

  /** `field`'s change over (`fromDate`, `toDate`] — the value at `toDate`
   * minus the value at `fromDate`, each read via getFieldAt. Null if either
   * side is null (a delta against an unrecorded field is not a number). */
  getFieldDelta(id, field, fromDate, toDate) {
    const before = this.getFieldAt(id, field, fromDate);
    const after = this.getFieldAt(id, field, toDate);
    if (before === null || after === null) return null;
    return after - before;
  }

  /** ids of every indexed item whose latest known workItemType is in
   * `types` — a project-wide scan of the (already in-memory) revision
   * index, used by server/scrum.js to find every backlog-level item this
   * project has ever revised, independent of any one person's assignment
   * (the per-person dashboard's WIQL queries answer a different question). */
  getIdsByType(types) {
    const wanted = new Set(types || []);
    const ids = [];
    for (const [id, revs] of this.revisionIndex) {
      const last = revs[revs.length - 1];
      if (last && wanted.has(last.workItemType)) ids.push(id);
    }
    return ids;
  }

  /** Every logged hour, by person, within (fromDate, toDate] — the NET
   * CompletedWork delta per item's revisions in the window, summed by
   * `changedBy`, project-wide. US3's utilisation view needs everyone who
   * logged time during the sprint regardless of who the item is CURRENTLY
   * assigned to, which is why this scans every indexed item rather than one
   * person's tree (contrast the per-person dashboard's own hours card).
   * A person's net negative (pure corrections) clamps to 0, matching
   * compute/timeline.js's existing rule for the same reason. */
  getLoggedHoursInRange(fromDate, toDate) {
    const byPerson = new Map();
    for (const [, revs] of this.revisionIndex) {
      let prev = null;
      for (const entry of revs) {
        const cur = entry.completedWork == null ? null : Number(entry.completedWork);
        if (prev != null && cur != null && entry.changedDate && entry.changedDate > fromDate && entry.changedDate <= toDate) {
          const delta = cur - prev;
          if (delta !== 0) {
            const key = entry.changedBy || '(unknown)';
            byPerson.set(key, (byPerson.get(key) || 0) + delta);
          }
        }
        if (cur != null) prev = cur;
      }
    }
    for (const [k, v] of byPerson) if (v < 0) byPerson.set(k, 0);
    return byPerson;
  }

  /** Who made progress on a specific set of items within (fromDate, toDate] —
   * the same NET CompletedWork delta logic as getLoggedHoursInRange, but
   * scoped to `ids` rather than every indexed item. Velocity's off-roster
   * detection (FR-026a) needs this per-story (one story's own items, one
   * sprint's dates) rather than project-wide, since it is asking "who
   * touched THIS story's tree in THIS sprint", not "who logged any hours
   * anywhere". Returns a Set of changedBy keys (no hours needed — FR-026b
   * only requires the names, not amounts, for velocity's disclosure). */
  getContributorsFor(ids, fromDate, toDate) {
    const contributors = new Set();
    for (const id of ids) {
      const revs = this.revisionIndex.get(id);
      if (!revs) continue;
      let prev = null;
      for (const entry of revs) {
        const cur = entry.completedWork == null ? null : Number(entry.completedWork);
        if (prev != null && cur != null && cur > prev && entry.changedDate && entry.changedDate > fromDate && entry.changedDate <= toDate) {
          contributors.add(entry.changedBy || '(unknown)');
        }
        if (cur != null) prev = cur;
      }
    }
    return contributors;
  }

  /** ids of every indexed item whose LATEST known IterationPath equals
   * `path` — the sprint-membership question the sprint work-item detail read
   * (server/ado/sprintItems.js) needs an id set for, derived from this
   * project's own index rather than a new WIQL query (Principle I). Returned
   * regardless of work item type; callers filter to the types they care
   * about (story-level for progress/scope-change, every type for
   * impediments). */
  getIdsByIteration(path) {
    const ids = [];
    for (const [id, revs] of this.revisionIndex) {
      const last = revs[revs.length - 1];
      if (last && last.iterationPath === path) ids.push(id);
    }
    return ids;
  }

  /** Map<parentId, childId[]> built from every indexed item's parentId
   * history — the story/task hierarchy velocity and progress aggregate
   * over. Derived from the index rather than a new WIQL query (Constitution
   * Principle I; see ado/revisionIndex.js `parentId`).
   *
   * @param {string|null} [asOf] A7: when given, each item's parent is
   *   resolved AS AT that date (its latest revision at or before `asOf`),
   *   not the current/latest one. Reparenting a task retroactively moves
   *   its historical hours between stories if the CURRENT parent is used
   *   for a CLOSED sprint's figures — adjacent to the immutability FR-008c
   *   protects, and invisible when it happens. Callers that genuinely want
   *   "now" (e.g. the current sprint's own backlog list) pass nothing and
   *   keep the original latest-revision behaviour. */
  getChildrenMap(asOf = null) {
    const map = new Map();
    for (const [id, revs] of this.revisionIndex) {
      let parentId = null;
      for (const r of revs) {
        if (asOf && r.changedDate && r.changedDate > asOf) break;
        if ('parentId' in r) parentId = r.parentId;
      }
      if (parentId == null) continue;
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId).push(id);
    }
    return map;
  }

  /** Sprints ordered by startDate ascending (FR-002 — never by name, since
   * "Sprint 149" < "Sprint 78" as strings). Sprints with no known dates are
   * separated out and counted rather than silently dropped or sorted
   * arbitrarily (spec edge case). */
  async getSprints() {
    const iterationMap = await this.ensureIterationMap();
    const withDates = [];
    let excludedNoDates = 0;
    const today = new Date().toISOString().slice(0, 10);
    for (const node of iterationMap.values()) {
      if (!node.startDate || !node.finishDate) {
        excludedNoDates += 1;
        continue;
      }
      const start = node.startDate.slice(0, 10);
      const finish = node.finishDate.slice(0, 10);
      const status = today < start ? 'future' : today > finish ? 'past' : 'current';
      withDates.push({
        id: node.id || null,
        name: node.name,
        path: node.path,
        startDate: node.startDate,
        // ADO's own finishDate is midnight at the START of the last day
        // (e.g. a sprint ending June 14 carries "2025-06-14T00:00:00Z"), but
        // every Scrum consumer (velocity/utilisation/burndown/scope-change,
        // server/scrum.js) treats a sprint's date range as (startDate,
        // finishDate] and reads `finishDate` as "as of sprint end" — used
        // as-is, that excludes every revision made ON the last calendar day,
        // shifting the sprint's final day of work into the NEXT sprint's
        // numbers instead. Normalizing to the end of that same calendar day
        // here, once, is what makes finishDate actually mean "sprint end".
        finishDate: `${finish}T23:59:59.999Z`,
        status,
        datesKnown: true,
      });
    }
    withDates.sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0));
    const currentPath = (withDates.find((s) => s.status === 'current') || {}).path || null;
    return { sprints: withDates, currentPath, excludedNoDates };
  }

  /** Records progress for one step of one person's in-progress sync pass.
   * `fraction` (0-1) is how far through that step this call represents.
   * The stored `pct` is monotonic — Math.max against whatever was already
   * there — because the two-phase driver (partial pass, then full pass)
   * legitimately revisits earlier steps, and a progress bar that jumps
   * backwards reads as broken. */
  _setStep(personId, stepId, fraction = 0, detail = null) {
    const scale = this.progressScale.get(personId) || { base: 0, span: 100 };
    const weightBefore = SYNC_STEP_WEIGHT_BEFORE.get(stepId) ?? 0;
    const step = SYNC_STEPS.find((s) => s.id === stepId);
    const weight = step ? step.weight : 0;
    const localPct = weightBefore + weight * Math.max(0, Math.min(1, fraction));
    const pct = Math.round(scale.base + (localPct / 100) * scale.span);

    const prev = this.progress.get(personId);
    const label = detail || (step ? step.label : SYNC_STEP_LABEL.get(stepId) || '');
    this.progress.set(personId, {
      phase: stepId,
      label,
      pct: Math.max(prev ? prev.pct : 0, pct),
      partial: scale.span < 100,
      startedAt: prev ? prev.startedAt : Date.now(),
      updatedAt: Date.now(),
    });
  }

  /** How a sync pass's own internal 0-100 progress maps onto the overall
   * bar shown to the client — see PARTIAL_PROGRESS_SPAN. */
  _setProgressScale(personId, { base, span }) {
    this.progressScale.set(personId, { base, span });
  }

  /** Current sync progress for `personId`, or null if nothing is running
   * (or nothing has ever run) for them — GET /api/sync/progress's payload. */
  getProgress(personId) {
    return this.progress.get(personId) || null;
  }

  /** For ids whose earliest indexed revision already carries a nonzero
   * CompletedWork value with rev > 1, the index alone can't tell whether
   * that value was set before INDEX_START_DATE or built up gradually
   * within the window — the true origin is unknown. Seeds those (and only
   * those) from a one-off `/updates` call, cached permanently, so this
   * cost is paid at most once per item, ever, across every person. */
  async ensureBoundarySeeded(ids, onProgress) {
    const needsSeeding = ids.filter((id) => {
      if (this.boundarySeeded.has(id) || this.updatesCache[id]) return false;
      const revs = this.revisionIndex.get(id);
      if (!revs || revs.length === 0) return false;
      const first = revs[0];
      return first.rev > 1 && first.completedWork != null && first.completedWork !== 0;
    });
    if (needsSeeding.length === 0) {
      if (onProgress) onProgress(1, 1);
      return;
    }

    let done = 0;
    await mapWithConcurrency(needsSeeding, BOUNDARY_SEED_CONCURRENCY, async (id) => {
      try {
        this.updatesCache[id] = await getWorkItemUpdates(this.client, id);
      } catch (err) {
        // best-effort — that one item's early history stays approximate
      } finally {
        this.boundarySeeded.add(id);
        done += 1;
        if (onProgress) onProgress(done, needsSeeding.length);
      }
    });
    this.cache.set('workItemUpdates', this.updatesCache);
  }

  /** The authenticated user — the default dashboard and the only person
   * whose data is polled in the background or writable. */
  async getSelf() {
    const { identity } = await this.ensureDiscovery();
    return identity;
  }

  /** True when `uniqueName` is allowed to clear this project's cache /
   * trigger a full resync — both destructive/project-wide actions. Compares
   * against `config.ownerEmail` when set (the deployment owner, owner in
   * every project); falls back to the service PAT's own identity otherwise,
   * so a single-user deployment with no ADO_OWNER_EMAIL configured keeps its
   * original "only the PAT owner" behavior.
   *
   * The fallback is gated on the read token actually being the SERVICE token:
   * when a scope runs on a user's PAT instead (a project ADO_PAT can't read —
   * see server/scopes.js), getSelf() is that user, and honoring the fallback
   * would silently hand whoever opened the project first the right to wipe
   * its cache and trigger project-wide resyncs. */
  async isOwner(uniqueName) {
    if (!uniqueName) return false;
    const candidate = uniqueName.toLowerCase();
    if (this.config.ownerEmail) return candidate === this.config.ownerEmail;
    if (this.config.readTokenIsService === false) return false;
    const self = await this.getSelf();
    return !!self.uniqueName && candidate === self.uniqueName.toLowerCase();
  }

  /** Wipes all disk + in-memory caches and resets in-process state so the
   * next request fetches fresh data from Azure DevOps. */
  clearCache() {
    this.discovery = null;
    this.iterationMap = null;
    this.people = null;
    this.types = null;
    this.typesInFlight = null;
    this.states = null;
    this.estimateField = undefined;
    this.estimateFieldReady = null;
    this.roles = null;
    this.unresolvedTeammates = new Map();
    this.updatesCache = {};
    this.revisionIndex = new Map();
    this.revisionWatermark = INDEX_START_DATE;
    this.revisionIndexReady = null;
    this.boundarySeeded = new Set();
    this.inFlight = new Map();
    this.prFillInFlight = new Map();
    const { readdirSync, unlinkSync } = require('fs');
    try {
      for (const f of readdirSync(this.config.cacheDir)) {
        try { unlinkSync(require('path').join(this.config.cacheDir, f)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    this.cache.mem.clear();
  }

  /** Looks up a cached-dashboard person id against the people roster,
   * independent of any caller session — used only by the background full-
   * resync pass in `_runFullResync`, which has no "who's asking" to be
   * relative to. `isSelf` is always false here; whoever actually requests
   * this person's dashboard gets the correct, session-relative `isSelf`
   * from `GET /api/dashboard` (see server/index.js), which never trusts the
   * cached payload's own `isSelf` for exactly this reason. */
  async _lookupPerson(id) {
    const people = await this.ensurePeople();
    const match = people.find((p) => p.id === id);
    if (!match) return null;
    const identities = await this.ensureIdentitySet(match).catch(() => primaryOnlySet(match, { degraded: true }));
    return { ...match, isSelf: false, identities };
  }

  /** Prefers the name a person set for themselves on the org chart (wiki)
   * over the one ADO/the PAT reports — someone's ADO display name is often a
   * formal/legal one they don't otherwise control, while the wiki row is
   * hand-edited via Manage Team. Falls through to the ADO name unchanged
   * when the person has no org chart row (or it isn't loaded) — see
   * OrgStore.load's "wiki, else best-effort cache, else empty" chain, which
   * this deliberately never awaits: a store that hasn't loaded yet just
   * yields no override, not a delay on every dashboard load. */
  _withOrgDisplayName(person) {
    if (!person || !person.uniqueName) return person;
    const orgMember = findMemberByEmail(this.orgStore.getStore(), person.uniqueName);
    return orgMember ? { ...person, displayName: orgMember.displayName } : person;
  }

  /** Resolves an identity id to {id, displayName, uniqueName, isSelf,
   * identities}, relative to `sessionIdentity` — the caller's own identity,
   * resolved from their session (or the service PAT owner, when auth is
   * disabled). Falls back to `sessionIdentity` when no id is given.
   *
   * 006-linked-identity-aliases: `identities` is always attached, for BOTH
   * the caller's own dashboard and a teammate's (Team page) — a teammate's
   * `identities` describes THAT teammate's linked accounts, not the
   * viewer's, so the disclosure (FR-009) and the widened reads that follow
   * are always about whichever person the dashboard is actually for.
   * `person.id` / `person.uniqueName` keep meaning the PRIMARY identity —
   * this is what leaves `ado/writeback.js#assertAssignedTo` untouched and is
   * why a linked identity never becomes a write subject (FR-008): nothing
   * downstream of this method ever mistakes `person.id` for anything but
   * the identity that actually signed in / owns this dashboard. */
  async resolvePerson(sessionIdentity, identityId) {
    if (!identityId || identityId === sessionIdentity.id) {
      const primary = {
        id: sessionIdentity.id,
        displayName: sessionIdentity.displayName,
        uniqueName: sessionIdentity.uniqueName,
      };
      const identities = await this.ensureIdentitySet(primary).catch(() =>
        primaryOnlySet(primary, { degraded: true })
      );
      return this._withOrgDisplayName({ ...primary, isSelf: true, identities });
    }
    const people = await this.ensurePeople();
    const match = people.find((p) => p.id === identityId);
    if (!match) return null;
    const identities = await this.ensureIdentitySet(match).catch(() => primaryOnlySet(match, { degraded: true }));
    return this._withOrgDisplayName({ ...match, isSelf: false, identities });
  }

  /** The team listed under `uniqueName`'s own entry on the roles wiki page —
   * resolved to full {id, displayName, uniqueName} records by matching
   * email against the people list. An email that doesn't resolve to a real
   * identity (typo, someone who left) is dropped rather than shown broken;
   * this is best-effort by design, since the roster lives in a wiki page
   * anyone with edit access could get wrong.
   *
   * A brand-new teammate is in neither of `fetchPeople`'s sources (no
   * project team membership yet, no work assigned in the last 365 days),
   * and the people list is cached for LONG_CACHE_TTL_MS (24h) besides — so
   * even right after adding them to the wiki, they'd stay invisible for up
   * to a day. Stragglers are resolved live via the identity picker, once,
   * and merged into the in-memory people list (never the 24h disk cache —
   * this is a one-off lookup, not part of the periodic snapshot). */
  async getTeamMembersFor(uniqueName, force = false) {
    const entry = await this.getRoleEntryFor(uniqueName, force);
    if (!entry || entry.team.length === 0) return [];
    const people = await this.ensurePeople();
    const byEmail = new Map(people.filter((p) => p.uniqueName).map((p) => [p.uniqueName.toLowerCase(), p]));

    const missing = entry.team.filter((email) => !byEmail.has(email) && !this._recentlyUnresolved(email));
    if (missing.length > 0) await this._resolveTeammatesLive(missing, byEmail);

    const resolved = entry.team.map((email) => byEmail.get(email)).filter(Boolean);
    // Belt and braces beyond parseRoles' own dedupe/self-exclusion: two
    // different wiki emails can resolve to the same identity, and the
    // caller's own uniqueName might resolve to a different-cased/aliased
    // match than the literal string comparison there caught.
    const seenIds = new Set();
    const deduped = [];
    for (const person of resolved) {
      if (person.uniqueName && person.uniqueName.toLowerCase() === uniqueName.toLowerCase()) continue;
      if (seenIds.has(person.id)) continue;
      seenIds.add(person.id);
      deduped.push(this._withOrgDisplayName(person));
    }
    return deduped;
  }

  /** Splits `resolvedMembers` (the ADO person records getTeamMembersFor just
   * resolved) into the named groups org.js's rosterGroupsFor computed from
   * the org chart, so the Team page can offer "pick a whole team" alongside
   * individual people. Purely a re-keying step — resolvedMembers is already
   * scoped/deduped/self-excluded, this just maps each org-chart email in a
   * group to the matching ADO person id, dropping any that didn't resolve
   * and any group left empty as a result (e.g. an unresolvable wiki email). */
  getRosterGroupsFor(uniqueName, resolvedMembers) {
    const self = findMemberByEmail(this.orgStore.getStore(), uniqueName);
    if (!self) return [];
    const byEmail = new Map(resolvedMembers.filter((p) => p.uniqueName).map((p) => [p.uniqueName.toLowerCase(), p.id]));
    // Keyed by person, not by the primary membership row — must match the
    // fold rolesMapFrom used to build `resolvedMembers`, or members appear
    // that no group contains. See org.js rosterGroupsForEmail.
    const groups = rosterGroupsForEmail(this.orgStore.getStore(), uniqueName);
    return groups
      .map((g) => ({ id: g.id, label: g.label, memberIds: g.emails.map((email) => byEmail.get(email)).filter(Boolean) }))
      .filter((g) => g.memberIds.length > 0);
  }

  /** True if `email` was looked up via the identity picker in the last 10
   * minutes and came back empty — suppresses repeat IdentityPicker calls for
   * a permanently typo'd wiki email on every Team page mount. */
  _recentlyUnresolved(email) {
    const ts = this.unresolvedTeammates.get(email);
    return typeof ts === 'number' && Date.now() - ts < UNRESOLVED_TEAMMATE_SUPPRESS_MS;
  }

  async _resolveTeammatesLive(emails, byEmail) {
    const found = [];
    await mapWithConcurrency(emails, 4, async (email) => {
      let results;
      try {
        results = await searchIdentities(this.client, email);
      } catch (err) {
        results = [];
      }
      const match = results.find((r) => r.uniqueName && r.uniqueName.toLowerCase() === email);
      if (match) found.push(match);
      else this.unresolvedTeammates.set(email, Date.now());
    });
    if (found.length === 0) return;

    this.registerPeople(found);
    for (const p of found) byEmail.set(p.uniqueName.toLowerCase(), p);

    // Persist into the 24h people cache too, so a restart doesn't lose them —
    // reusing the existing fetchedAt so this doesn't reset the refresh cycle.
    const cached = this.cache.get('people');
    this.cache.set('people', { fetchedAt: cached ? cached.fetchedAt : Date.now(), people: this.people });
  }

  async _getWorkItemUpdates(id) {
    if (this.updatesCache[id]) return this.updatesCache[id];
    const updates = await getWorkItemUpdates(this.client, id);
    this.updatesCache[id] = updates;
    return updates;
  }

  _cacheKey(identityId) {
    // v4: bumped when Story gained a `blocked` field (the Dashboard's
    // "Blocked stories" tile) so a stale-shaped payload already in .cache/
    // isn't served instantly on restart.
    // v6: two independent project-scoping fixes, either of which on its own
    // makes an older payload wrong to serve rather than merely stale.
    //  - Pull requests became project-scoped. A pre-v6 payload's prRepos,
    //    openPullRequests count and per-story PR lists came from the ORG-wide
    //    PR search, so repainting one on restart would show another project's
    //    pull requests under this project.
    //  - The work item queries gained their [System.TeamProject] clause. WIQL
    //    is org-scoped (see ado/workitems.js teamProjectClause), so a pre-v6
    //    payload's stories, tasks, sprints, hours and every derived count were
    //    built from every project's work items at once.
    // v7: IterationGroup gained `crossSprintItems` (always an array, never
    // undefined — 005-search-history-sprint-placement). A pre-v7 cached
    // payload has no such key at all, and the client unconditionally calls
    // `.filter()`/`.map()` on it (WorkItemsView.tsx's filteredGroups,
    // distinctGroupItemIds) — crashing the Work Items page with "Cannot read
    // properties of undefined" the instant a warm cache from before this
    // deploy is served, live-verified via tools/verify-ui.cjs. Bumping here
    // forces exactly the one resync needed to backfill the field, the same
    // fix v4/v6 above already used for their own shape changes.
    // v8 (006-linked-identity-aliases): a person's stories/tasks/PRs/hours
    // widened to their WHOLE identity set instead of a single uniqueName,
    // and every item gained an `editable` field. A pre-v8 payload was built
    // from one identity only — repainting it on restart would show a
    // migrated person an incomplete dashboard that LOOKS authoritative
    // (no error, just quietly missing the other identity's items), which is
    // worse than the shape-crash v7 guards against, and it has no `editable`
    // key at all for the client's edit-control gating to read. Same
    // discard-and-resync remedy as v4/v6/v7.
    //
    // The revision index itself is deliberately NOT re-versioned by this
    // change: it is project-wide and person-agnostic (see
    // ado/revisionIndex.js), and only the per-person READ of it widens — so
    // no cold re-walk is incurred by this bump.
    // Discarding them costs one resync and is the only way to be sure a leaked
    // payload is never served.
    //
    // v9 (007-all-assigned-types): the payload now holds every assigned item
    // whatever its type (plus childless stories); a v8 payload is missing all
    // of them yet looks authoritative — the same reasoning as v8 itself.
    return `dashboard-v9-${identityId}`;
  }

  getCachedDashboard(identityId) {
    return this.cache.get(this._cacheKey(identityId)) || null;
  }

  _prIndexCacheKey(identityId) {
    // v2: same reason as dashboard-v5 — a v1 index is an org-wide PR list.
    // v3 (006-linked-identity-aliases): the index is now the UNION of PRs
    // found under every identity in the person's set, not just one — same
    // "an old payload looks complete but silently isn't" reasoning as
    // dashboard-v8 above. (007 bumped the dashboard to v9 but not this: the
    // PR index never depended on work item types.)
    return `pr-index-v3-${identityId}`;
  }

  /** The cheap tier of PR data: every windowed, normalized PR for this
   * person (repository/status/id — everything GET /api/pullrequests needs
   * to group, filter, count, and search) with NO attribution attached, so
   * building/reading it costs no per-PR HTTP calls. Sorted by activity desc
   * — see prActivity in server/compute/prGroups.js — so "first N" always
   * means "N most recent". */
  getPrIndex(identityId) {
    return this.cache.get(this._prIndexCacheKey(identityId)) || null;
  }

  _setPrIndex(identityId, prs) {
    this.cache.set(this._prIndexCacheKey(identityId), {
      personId: identityId,
      builtAt: Date.now(),
      prs: [...prs].sort((a, b) => prActivity(b) - prActivity(a)),
    });
  }

  /** True once a cached dashboard is old enough that it should be served
   * instantly but also revalidated in the background — see STALE_AFTER_MS.
   * A `partial` dashboard is always stale: it's a placeholder the full pass
   * is meant to replace, and if that full pass never landed (crash, restart
   * mid-sync) this is what makes it self-heal on the next request rather
   * than staying permanently incomplete. */
  isStale(dashboard) {
    if (!dashboard) return true;
    if (dashboard.partial) return true;
    return Date.now() - new Date(dashboard.syncedAt).getTime() > STALE_AFTER_MS;
  }

  /** Dedupes concurrent syncs for the same person — two browser tabs
   * selecting the same teammate shouldn't each fire hundreds of API calls.
   * `force: true` (the "Reload All Data" button) deliberately does NOT join
   * an already-running sync — that sync may have started before whatever
   * change the user is trying to see, so joining it could report success
   * while still showing stale data. Instead it's queued to run right after
   * the in-flight one finishes, never in parallel with it (parallel syncs
   * for the same person would double up on ADO calls and race each other's
   * cache writes). */
  syncPerson(person, { force = false } = {}) {
    const existing = this.inFlight.get(person.id);
    if (existing && !force) return existing;
    const run = existing ? existing.catch(() => {}).then(() => this._runSync(person)) : this._runSync(person);
    const promise = run
      .then((dashboard) => {
        // A successful sync under this scope's read token proves it's still
        // good — clears any earlier invalid-token state.
        this.readTokenInvalid = false;
        this.selfSyncErrors.delete(person.id);
        return dashboard;
      })
      .catch((err) => {
        // A bare 401 (not 403/409/ForbiddenError, which mean something
        // else entirely) means Azure DevOps rejected this scope's read token
        // itself. No extra request is made to detect this — it rides on
        // whatever sync (background poll or on-demand) already failed.
        if (err && err.status === 401) {
          this.readTokenInvalid = true;
          if (person.isSelf) this.selfSyncErrors.set(person.id, err);
        }
        throw err;
      })
      .finally(() => {
        // Guarded: an older promise's `finally` must not delete a newer one's
        // in-flight entry (can happen when `force` chained a second sync in).
        if (this.inFlight.get(person.id) === promise) {
          this.inFlight.delete(person.id);
          this.progress.delete(person.id);
          this.progressScale.delete(person.id);
        }
      });
    this.inFlight.set(person.id, promise);
    return promise;
  }

  /** Full resync: forces the shared caches to refetch, then forces a resync
   * of `person`, then — in the background, one at a time — resyncs every
   * other person who already has a cached dashboard, so a teammate's stale
   * Team-page view heals itself without the viewer having to do anything.
   * Concurrent calls collapse into one run rather than compounding. */
  async fullResync(person) {
    if (this.fullResyncInFlight) return this.fullResyncInFlight;
    this.fullResyncInFlight = this._runFullResync(person).finally(() => {
      this.fullResyncInFlight = null;
    });
    return this.fullResyncInFlight;
  }

  async _runFullResync(person) {
    await this.refreshShared();
    const dashboard = await this.syncPerson(person, { force: true });

    const prefix = this._cacheKey('');
    const others = this.cache
      .keys()
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
      .filter((id) => id !== person.id);

    (async () => {
      for (const id of others) {
        try {
          const other = await this._lookupPerson(id);
          if (other) await this.syncPerson(other, { force: true });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[sync] full resync background pass failed for ${id}:`, err.message);
        }
      }
    })().catch(() => {});

    return { syncedAt: dashboard.syncedAt, backgroundCount: others.length };
  }

  /**
   * Runs one sync pass for `person`. `since` (ISO date or null) windows the
   * ADO queries — used by the fast partial pass (see `_runSync`, the
   * two-phase driver below) — and `partial` marks the resulting payload as
   * such. A full pass (`since: null, partial: false`) is exactly the sync
   * this method used to be before the two-phase split.
   */
  async _runSyncPass(person, { since = null, partial = false } = {}) {
    this._setStep(person.id, 'shared', 0);
    // Revision index refresh runs alongside everything else — steady-state
    // it's ~1 cheap request, so it never meaningfully adds to sync time.
    const [discovery, iterationMap, , states, types] = await Promise.all([
      this.ensureDiscovery(),
      this.ensureIterationMap(),
      this.ensureRevisionIndex(),
      this.ensureStates(),
      this.ensureTypes(),
    ]);
    const { blockedSignal } = discovery;
    this._setStep(person.id, 'query', 0);

    // The type names in both WIQL queries come from this project's own process
    // template (ensureTypes) — hardcoding 'User Story'/'Task' would return
    // nothing at all on a Scrum or Basic project.
    //
    // Passing `person` itself (not `person.uniqueName`) is what widens these
    // to the whole identity set (006-linked-identity-aliases) — see
    // `identityNames` in ado/workitems.js, which reads `person.identities.all`
    // when given an object and falls back to a single name for a bare string,
    // so a caller with no `identities` attached (a stray older call site)
    // degrades to exactly today's single-identity query rather than throwing.
    const { storyIds, taskIds, parentOf } = await queryAssignedTree(this.client, person, {
      since,
      storyTypes: types.storyTypes,
    });
    // Every item assigned to the person, whatever its type and with no state
    // clause (007-all-assigned-types — see queryAssignedItems).
    const assignedIds = await queryAssignedItems(this.client, person, { since });
    const storyIdSet = new Set(storyIds);
    // Not already pulled in as a child task, and not itself acting as a
    // story-like container — placed below, by category, once hydrated.
    const outsideTreeIds = assignedIds.filter((id) => !parentOf.has(id) && !storyIdSet.has(id));
    this._setStep(person.id, 'hydrate', 0);

    // 006-linked-identity-aliases: one PR search per identity, unioned — see
    // fetchPullRequests's own doc comment for why the per-identity retry
    // must stay inside each fetch rather than racing under Promise.all.
    const personIds = (person.identities && person.identities.all.map((i) => i.id)) || [person.id];
    const [rawStories, rawTasks, rawOutsideTree, prs] = await Promise.all([
      hydrateWorkItemsWithRelations(this.client, storyIds),
      hydrateWorkItemsWithRelations(this.client, taskIds),
      hydrateWorkItemsWithRelations(this.client, outsideTreeIds),
      fetchPullRequests(this.client, personIds),
    ]);
    this._setStep(person.id, 'prs', 0);

    // 007-all-assigned-types. First, a Removed item is dropped by its type's
    // workflow CATEGORY (research.md R13) — before it reaches any pool,
    // relevantIds, the hours lookup, or summary.hiddenByStateCount, so it is
    // excluded exactly as the old literal `<> 'Removed'` clause excluded it,
    // never shown as "hidden by state". An item whose type has no known
    // workflow can't be categorised and is kept (read-only, FR-009).
    //
    // Then the rest is placed by type category, never by name
    // (classifyByCategory, research.md R3): a requirement-category item here
    // is a CHILDLESS story — the tree query is a workItemLinks query, which
    // returns no row for a story with no Hierarchy-Forward link — and
    // everything else (bugs, tasks, Features, custom types…) is an
    // unparented item.
    const rawOutsideLive = rawOutsideTree.filter((raw) => {
      const f = raw.fields || {};
      return stateCategoryOf(f['System.WorkItemType'], f['System.State'], states) !== 'Removed';
    });
    const isStoryRaw = (raw) => classifyByCategory((raw.fields || {})['System.WorkItemType'], types) === 'story';
    const rawChildlessStories = rawOutsideLive.filter(isStoryRaw);
    const rawUnparented = rawOutsideLive.filter((raw) => !isStoryRaw(raw));
    const childlessStoryIds = rawChildlessStories.map((raw) => raw.id);
    const unparentedIds = rawUnparented.map((raw) => raw.id);

    // ORG-wide on purpose — the one deliberate exception to project scoping in
    // this app. See the module comment in ado/pullrequests.js for the reasoning;
    // each PR carries its own projectName so the UI can label the ones that came
    // from another project.
    const normalizedPrs = prs.map((p) => normalizePr(p, this.config.org));
    // Caps attribution/rendering to recent history (ADO_PR_HISTORY_MONTHS,
    // default 12) plus every still-`active` PR regardless of age — the
    // single biggest cost lever on a cold sync, since attribution is 2 HTTP
    // requests per PR (see server/ado/prAttribution.js). summary.openPullRequests
    // below still reads the full, unwindowed `prs`, so that stat stays exact
    // even though prRepos/GET-/api/pullrequests only cover the windowed set.
    const windowedPrs = filterPrHistoryWindow(normalizedPrs, this.config.prHistoryMonths);

    // Never let one empty PR fetch wipe an index that had entries.
    //
    // `fetchPullRequests` pages until a short page ends it, so an ADO response
    // of `{value: []}` is indistinguishable from "this person has no pull
    // requests" — it just returns an empty list, with no error to catch. That
    // happened for real: under a burst of rate-limit throttling (the server log
    // filled with `[ado] throttled ... low X-RateLimit-Remaining`), one project's
    // sync came back with zero PRs, overwrote a perfectly good 243-PR index with
    // an empty one, and the Pull Requests page went blank and stayed blank — the
    // cached emptiness outlived the throttling that caused it.
    //
    // Nothing here can tell the two cases apart, so it doesn't try: if the fetch
    // returns nothing while a previous index held PRs, that's treated as a failed
    // fetch. The previous index is kept and reused for this pass. The cost of
    // being wrong is showing a stale PR list for one sync interval; the cost of
    // the alternative is a page that is empty until someone clears the cache.
    const previousIndex = this.getPrIndex(person.id);
    const prFetchLooksEmpty = normalizedPrs.length === 0 && previousIndex && previousIndex.prs.length > 0;
    // The cheap tier: repository/status/id for every windowed PR, no
    // attribution attached — everything GET /api/pullrequests needs to
    // group, filter, count, and search a page without any per-PR HTTP call.
    if (prFetchLooksEmpty) {
      // eslint-disable-next-line no-console
      console.warn(
        `[sync] ${this.config.project}: pull request fetch returned nothing for ${person.displayName} ` +
          `while ${previousIndex.prs.length} were cached — treating it as a failed fetch and keeping the cached set.`
      );
    } else {
      this._setPrIndex(person.id, windowedPrs);
    }
    // Everything downstream (prRepos, the open-PR tile, attribution) reads these
    // rather than the raw fetch, so a kept-cached set stays self-consistent.
    const effectiveWindowedPrs = prFetchLooksEmpty ? previousIndex.prs : windowedPrs;
    const effectiveAllPrs = prFetchLooksEmpty ? previousIndex.prs : normalizedPrs;

    // Resolving each PR to the story it belongs to (title/linked-items/
    // commits — see server/ado/prAttribution.js) is 2 HTTP requests per PR,
    // by far the most expensive step on a full pass. The partial (14-day)
    // pass is cheap enough to attribute inline — few PRs, most already
    // `active` — and that's the fast path a cold sync's first paint depends
    // on. The full pass instead reuses whatever the previous sync already
    // attributed (so story cards don't flash empty on every routine
    // resync) and hands the real attribution off to a background fill
    // (_fillStoryPrs) that patches the cache and pushes an SSE update once
    // it lands — see the `prsPending` flag on the payload below.
    let prsByStoryId;
    if (partial) {
      const prsToAttribute = since
        ? effectiveWindowedPrs.filter((p) => p.status === 'active' || (p.createdDate && p.createdDate >= since))
        : effectiveWindowedPrs;
      const attribution = await attributePullRequests(
        this.client,
        prsToAttribute,
        (done, total) => this._setStep(person.id, 'prs', total > 0 ? done / total : 1),
        // The ORG-wide cache, not this scope's: candidates are keyed by PR id
        // and a PR is the same PR whichever project you are viewing, so sharing
        // it is what stops each project re-paying 2 ADO requests per PR.
        this.orgCache,
        { storyTypes: types.storyTypes }
      );
      prsByStoryId = buildPrsByStoryId(effectiveWindowedPrs, attribution);
    } else {
      prsByStoryId = collectPrsByItemId(this.getCachedDashboard(person.id));
      this._setStep(person.id, 'prs', 1);
    }

    const tasksByStory = new Map();
    for (const raw of rawTasks) {
      const normalized = withHoursCapability(normalizeTask(raw, blockedSignal, states), types);
      // Attribution resolves to a story, not a task — see
      // server/ado/prAttribution.js. Never rendered on the task card today,
      // kept only so the Task type's shape stays consistent with Story's.
      normalized.pullRequests = [];
      // 006-linked-identity-aliases (FR-008, T023): a UI courtesy only — the
      // server independently refuses the write regardless (assertAssignedTo
      // in ado/writeback.js), so this never needs to be trusted as
      // enforcement, only kept honest with it.
      normalized.editable = isPrimary({ id: normalized.assignedToId, uniqueName: normalized.assignedToUniqueName }, person);
      const storyId = parentOf.get(raw.id);
      if (!tasksByStory.has(storyId)) tasksByStory.set(storyId, []);
      tasksByStory.get(storyId).push(normalized);
    }
    for (const tasks of tasksByStory.values()) tasks.sort(byChangedDateDesc);

    // Childless stories (007) take the same path with zero tasks.
    const allStories = [...rawStories, ...rawChildlessStories].map((raw) => {
      const allTasks = tasksByStory.get(raw.id) || [];
      // A story can carry other people's tasks too — those shouldn't count
      // toward this person's hours, progress, or task counts.
      const tasks = allTasks.filter((t) =>
        isPerson({ id: t.assignedToId, uniqueName: t.assignedToUniqueName }, person)
      );
      const storyPrs = prsByStoryId.get(raw.id) || [];
      const repository = storyPrs.length > 0 ? storyPrs[0].repository : null;
      const story = rollupStory(raw, tasks, repository, states, blockedSignal);
      story.editable = isPrimary({ id: story.assignedToId, uniqueName: story.assignedToUniqueName }, person);
      story.pullRequests = storyPrs;
      story.hiddenTaskCount = allTasks.length - tasks.length;
      return story;
    });

    const allUnparented = rawUnparented.map((raw) => {
      const normalized = withHoursCapability(normalizeTask(raw, blockedSignal, states), types);
      normalized.pullRequests = prsByStoryId.get(raw.id) || [];
      normalized.editable = isPrimary({ id: normalized.assignedToId, uniqueName: normalized.assignedToUniqueName }, person);
      return normalized;
    });

    // Revision history for hours-per-day, read from the shared index —
    // built once for the whole project, not fetched per person. Computed
    // over EVERY item regardless of current state: hours logged in the
    // past are a historical fact and must not disappear because an item
    // later closed. `relevantIds` is deliberately the raw, unfiltered tree —
    // queryAssignedTree returns teammates' tasks under a story this person
    // owns (and other people's stories that merely contain a task of
    // theirs) on purpose, so `hiddenTaskCount` above can report them — but
    // buildDailyHoursFromIndex attributes each delta to whoever's
    // `changedBy` actually made that revision, not to the item's current
    // assignee, so a teammate's hours logged on a teammate's task never
    // land here just because the item is reachable from this person's tree.
    const relevantIds = [...storyIds, ...taskIds, ...childlessStoryIds, ...unparentedIds];
    this._setStep(person.id, 'history', 0);
    await this.ensureBoundarySeeded(relevantIds, (done, total) =>
      this._setStep(person.id, 'history', total > 0 ? (done / total) * 0.8 : 0.8)
    );
    // 006-linked-identity-aliases: personKey widens from one lowercased
    // uniqueName to the whole identity set's keys (a Set) — a revision has
    // exactly one changedBy, so this counts each revision once regardless
    // of which of the person's identities made it (FR-007). Falls back to
    // the single-key form when `identities` isn't attached, matching the
    // exact pre-widening behaviour.
    const personKey = person.identities ? person.identities.keys : person.uniqueName ? person.uniqueName.toLowerCase() : null;
    const { daily, perItem } = buildDailyHoursFromIndex(this.revisionIndex, relevantIds, this.updatesCache, personKey);
    this._setStep(person.id, 'history', 1);
    const timeline = buildTimeline(daily);

    // Title/type for the hours breakdown drill-down — built from the raw,
    // unfiltered items so it can resolve an id even when that item is
    // state-filtered out of the visible dashboard (relevantIds above is
    // itself unfiltered, for the same reason: hours logged in the past are
    // a historical fact regardless of the item's current state).
    const itemLookup = new Map();
    for (const raw of [...rawStories, ...rawTasks, ...rawChildlessStories, ...rawUnparented]) {
      const f = raw.fields || {};
      itemLookup.set(raw.id, { title: f['System.Title'] || `#${raw.id}`, type: f['System.WorkItemType'] || 'Unknown' });
    }
    timeline.breakdown = buildBreakdown(perItem, timeline.last7Days, itemLookup);

    // Only non-terminal states (per each item's own type workflow), and
    // only sprints from MIN_ITERATION_YEAR onward. Same filters for stories
    // and unparented items alike.
    const stateFiltered = allStories.filter((s) => isVisibleState(s.type, s.state, states));
    const visibleStories = stateFiltered
      .filter((s) => isRecentEnoughIteration(s.iterationPath, iterationMap))
      .sort(byChangedDateDesc);
    const unparentedStateFiltered = allUnparented.filter((t) => isVisibleState(t.type, t.state, states));
    const visibleUnparented = unparentedStateFiltered
      .filter((t) => isRecentEnoughIteration(t.iterationPath, iterationMap))
      .sort(byChangedDateDesc);

    const { groups, droppedCount } = groupByIteration(visibleStories, visibleUnparented, iterationMap);

    // groupByIteration never drops items — an IterationPath that fails to
    // resolve against iterationMap (e.g. "UDC", outside this project's
    // iteration tree) lands in the trailing "No sprint" bucket instead of
    // being dropped (see server/compute/iterationGrouping.js). Everything
    // downstream — the flat Stories list, PR grouping, and client-side
    // counts — still reads from the grouped output rather than
    // visibleStories/visibleUnparented directly, so it can never disagree
    // with what the grouped view actually renders.
    const displayedStories = groups.flatMap((g) => g.stories);
    const displayedUnparented = groups.flatMap((g) => g.unparentedItems);

    // "Recently updated" — mirrors ADO's own project-wide page, scoped to
    // this person: assigned to them, changed within RECENT_WINDOW_DAYS,
    // ordered exactly as ADO returns it (ChangedDate DESC). Independent of
    // the sprint-grouped pools' MIN_ITERATION_YEAR filter on purpose — see
    // queryRecentlyUpdated's doc comment. Resolved against the pools already
    // normalized above so the shapes match the Work Items page exactly. A
    // childless story assigned directly used to be the common miss here (no
    // Hierarchy-Forward link row, so queryAssignedTree never surfaces it);
    // since 007-all-assigned-types queryAssignedItems brings those in too, so
    // only the rare id the two queries' windows disagree on is hydrated +
    // normalized individually as a fallback.
    const recentIds = await queryRecentlyUpdated(
      this.client,
      person, // widened to the whole identity set — see the queryAssignedTree comment above
      partial ? PARTIAL_WINDOW_DAYS : RECENT_WINDOW_DAYS
    );
    const storyById = new Map(allStories.map((s) => [s.id, s]));
    const taskById = new Map([...tasksByStory.values()].flat().map((t) => [t.id, t]));
    for (const t of allUnparented) taskById.set(t.id, t);

    const missingIds = recentIds.filter((id) => !storyById.has(id) && !taskById.has(id));
    if (missingIds.length > 0) {
      const rawMissing = await hydrateWorkItemsWithRelations(this.client, missingIds);
      for (const raw of rawMissing) {
        const type = raw.fields && raw.fields['System.WorkItemType'];
        // By category, never by type name (research.md R6, Principle II).
        if (classifyByCategory(type, types) === 'item') {
          const normalized = withHoursCapability(normalizeTask(raw, blockedSignal, states), types);
          normalized.pullRequests = [];
          normalized.editable = isPrimary({ id: normalized.assignedToId, uniqueName: normalized.assignedToUniqueName }, person);
          taskById.set(raw.id, normalized);
        } else {
          const story = rollupStory(raw, [], null, states, blockedSignal);
          story.pullRequests = [];
          story.hiddenTaskCount = 0;
          story.editable = isPrimary({ id: story.assignedToId, uniqueName: story.assignedToUniqueName }, person);
          storyById.set(raw.id, story);
        }
      }
    }

    const recentItems = recentIds
      .map((id) => {
        const story = storyById.get(id);
        if (story) return { kind: 'story', story };
        const task = taskById.get(id);
        if (task) return { kind: 'task', task };
        return null; // hydration failed — drop silently rather than break the dashboard
      })
      .filter(Boolean)
      .filter((entry) => {
        const item = entry.kind === 'story' ? entry.story : entry.task;
        return isVisibleState(item.type, item.state, states);
      });

    this._setStep(person.id, 'assemble', 0);

    // Pull Requests page: per-repo summaries only — no PR bodies, no
    // attribution needed (repository/status/id are all on the cheap list
    // fetch). The PR bodies themselves are paged in on demand via
    // GET /api/pullrequests, which attributes only the page requested.
    const prRepos = summarizePrRepos(effectiveWindowedPrs);
    const prsPending = !partial && effectiveWindowedPrs.length > 0;

    // activeStories/completedStories/tasksInProgress/blockedTasks used to
    // live here, computed by different predicates than the Work Items page
    // filters with — that's what let the two pages disagree. They're now
    // computed client-side by the same predicates the filters use (see
    // web/src/lib/workItemViews.ts), so disagreement is structurally
    // impossible. Only server-only knowledge (PR data, hidden counts) stays
    // in summary.
    const summary = {
      // Matches the Pull Requests page's "Active" chip exactly — computed
      // with the same prStatusId bucketing (draft-first) rather than raw
      // pr.status, since a draft PR also carries status:'active' in ADO and
      // would otherwise make this tile overcount relative to what clicking
      // through to it shows.
      // Counted off the unwindowed list, so the tile agrees exactly with what
      // clicking through to the Pull Requests page shows (both org-wide). It
      // ignores ADO_PR_HISTORY_MONTHS on purpose: an `active` PR is never
      // windowed out, so the count stays exact.
      openPullRequests: effectiveAllPrs.filter((p) => prStatusId(p) === 'active').length,
      hiddenByStateCount:
        allStories.length - stateFiltered.length + (allUnparented.length - unparentedStateFiltered.length),
      hiddenByIterationCount:
        stateFiltered.length -
        displayedStories.length +
        (visibleUnparented.length - displayedUnparented.length),
    };

    // The state filter's options come from the types actually on THIS
    // dashboard (007-all-assigned-types, research.md R9): `states` now holds
    // every type in the process (Test Plan, Shared Steps, …), and unioning
    // all of them would offer states nothing here can ever match.
    const presentTypes = new Set([
      ...displayedStories.flatMap((s) => [s.type, ...(s.tasks || []).map((t) => t.type)]),
      ...displayedUnparented.map((t) => t.type),
      ...recentItems.map((e) => (e.kind === 'story' ? e.story : e.task).type),
    ]);
    const presentStates = Object.fromEntries(Object.entries(states).filter(([type]) => presentTypes.has(type)));

    const dashboard = {
      org: this.config.org,
      project: this.config.project,
      person: { id: person.id, displayName: person.displayName },
      isSelf: !!person.isSelf,
      visibleStates: visibleStateNames(presentStates),
      summary,
      stories: displayedStories,
      groups,
      recentItems,
      prRepos,
      prsPending,
      timeline,
      blockedSignal,
      syncedAt: new Date().toISOString(),
      partial,
      partialSince: since,
      // 006-linked-identity-aliases (FR-009, T024): describes whichever
      // person THIS dashboard is for (never the viewer) — a teammate's
      // dashboard on the Team page discloses the TEAMMATE's linked
      // identity. Always an array, never undefined, so the client can
      // iterate it unconditionally (same contract as `crossSprintItems` in
      // 005). `identitiesDegraded` lets the account-menu disclosure say the
      // view may be incomplete instead of silently implying there is
      // nothing to link (FR-005).
      linkedIdentities: (person.identities && person.identities.linked) || [],
      identitiesDegraded: !!(person.identities && person.identities.degraded),
    };

    this.cache.set(this._cacheKey(person.id), dashboard);
    this._notify(dashboard);
    this._setStep(person.id, 'assemble', 1);
    if (prsPending) {
      this._fillStoryPrs(person).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[sync] PR attribution fill failed for ${person.displayName}:`, err.message);
      });
    }
    return dashboard;
  }

  /** Background full-history PR attribution for `person` — deferred off the
   * main sync pass because it's 2 HTTP requests per PR (see
   * server/ado/prAttribution.js). Reads the cheap PR index this pass just
   * wrote (_setPrIndex), attributes it (the candidate cache makes this
   * nearly free for any PR already seen on a previous sync), then patches
   * the CACHED dashboard in place and re-notifies — see
   * applyStoryPrsToDashboard for why every nested location needs patching.
   * Deduped per person via prFillInFlight so an overlapping resync doesn't
   * double the work. */
  async _fillStoryPrs(person) {
    const existing = this.prFillInFlight.get(person.id);
    if (existing) return existing;
    const run = this._runFillStoryPrs(person).finally(() => {
      this.prFillInFlight.delete(person.id);
      this.progress.delete(person.id);
      this.progressScale.delete(person.id);
    });
    this.prFillInFlight.set(person.id, run);
    return run;
  }

  async _runFillStoryPrs(person) {
    const index = this.getPrIndex(person.id);
    if (!index || index.prs.length === 0) return;

    const prs = index.prs;
    const { storyTypes } = await this.ensureTypes();
    const attribution = await attributePullRequests(
      this.client,
      prs,
      (done, total) => this._setStep(person.id, 'prs', total > 0 ? done / total : 1),
      this.orgCache,
      { storyTypes }
    );
    const prsByStoryId = buildPrsByStoryId(prs, attribution);

    const dashboard = this.getCachedDashboard(person.id);
    if (!dashboard) return; // cache cleared or replaced while the fill was running
    applyStoryPrsToDashboard(dashboard, prsByStoryId);
    dashboard.prsPending = false;
    this.cache.set(this._cacheKey(person.id), dashboard);
    this._notify(dashboard);
  }

  /**
   * Two-phase entry point: a genuinely cold person (nothing cached at all)
   * gets a fast pass over the last PARTIAL_WINDOW_DAYS first — cached and
   * pushed immediately — before the real full pass runs and replaces it.
   * Logging hours bumps System.ChangedDate, so today/this-week/last7Days
   * come out of that fast pass exact, not approximate; only long series
   * (totalHours, activeDays) and the full work-item lists are incomplete
   * until the full pass lands, which the client surfaces via `partial`.
   *
   * A warm person (anything cached, even stale) skips straight to a single
   * full pass — the two-phase split only exists to shorten the very first
   * wait, not to always double the request count.
   *
   * `syncPerson`'s returned promise always resolves to the FULL pass's
   * result; the partial reaches the browser only via the cache write +
   * `_notify` above, same path a background revalidate uses.
   */
  async _runSync(person) {
    const cold = !this.getCachedDashboard(person.id);
    if (cold) {
      const since = new Date(Date.now() - PARTIAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
      this._setProgressScale(person.id, { base: 0, span: PARTIAL_PROGRESS_SPAN });
      try {
        await this._runSyncPass(person, { since, partial: true });
      } catch (err) {
        // Best-effort: the partial pass failing must never block the full
        // one — worst case, the client just waits a bit longer for data.
        // eslint-disable-next-line no-console
        console.error(`[sync] partial pass failed for ${person.displayName}:`, err.message);
      }
      this._setProgressScale(person.id, { base: PARTIAL_PROGRESS_SPAN, span: 100 - PARTIAL_PROGRESS_SPAN });
    } else {
      this._setProgressScale(person.id, { base: 0, span: 100 });
    }
    return this._runSyncPass(person, { since: null, partial: false });
  }

  /**
   * Applies a just-written field change directly into the cached dashboard
   * payload, so `GET /api/dashboard` can't hand back a value we already know
   * is stale during the debounce-plus-full-sync window before the next real
   * sync lands. Mirrors the client's own optimistic patch (see
   * web/src/lib/patchTask.ts) — deliberately narrow: only the named fields
   * on items matching `ids`, never rollups (hours totals, completionPct),
   * which only a real sync can recompute correctly.
   *
   * Walks every place the cached payload serializes the same work item as an
   * independent copy: `stories`, `groups[].stories[].tasks`,
   * `groups[].unparentedItems`, and `recentItems` (both the `story` and
   * `task` shapes).
   */
  _patchCachedWorkItems(personId, ids, fields) {
    if (!ids || ids.length === 0) return;
    const idSet = new Set(ids);
    const dashboard = this.getCachedDashboard(personId);
    if (!dashboard) return;

    const patchItem = (item) => (idSet.has(item.id) ? { ...item, ...fields } : item);
    const patchStory = (story) => ({
      ...patchItem(story),
      tasks: story.tasks.map(patchItem),
    });

    const patched = {
      ...dashboard,
      stories: dashboard.stories.map(patchStory),
      groups: dashboard.groups.map((g) => ({
        ...g,
        stories: g.stories.map(patchStory),
        unparentedItems: g.unparentedItems.map(patchItem),
      })),
      recentItems: dashboard.recentItems.map((entry) =>
        entry.kind === 'story' ? { ...entry, story: patchStory(entry.story) } : { ...entry, task: patchItem(entry.task) }
      ),
    };

    this.cache.set(this._cacheKey(personId), patched);
  }

  /**
   * Immediately injects a just-written revision into the in-memory revision
   * index so that the very next `buildDailyHoursFromIndex` call sees the
   * updated completedWork without waiting for ADO's reporting feed
   * (`/wit/reporting/workitemrevisions`) to propagate — that feed has an
   * eventual-consistency delay that can keep new hours invisible for
   * several minutes after a successful PATCH.
   *
   * `changedBy` is set explicitly to the writer's own uniqueName rather than
   * left null: buildDailyHoursFromIndex treats a null changedBy as "unknown,
   * fall back to current assignee" (safe for old history, but here we
   * already know exactly who wrote this revision, so recording it directly
   * is strictly more correct — and matters the moment someone writes hours
   * on a task that isn't assigned to them, e.g. right after a reassignment
   * whose sync hasn't landed yet).
   *
   * When the reporting feed finally returns this revision, `fetchRevisionsSince`
   * will overwrite the same entry (matched by rev) with ADO's own timestamp
   * and changedBy, which is a no-op for anything that matters (both already
   * match what we set here).
   */
  _injectRevisionIntoIndex(id, rev, completedWork, changedBy) {
    if (!this.revisionIndex.has(id)) this.revisionIndex.set(id, []);
    const arr = this.revisionIndex.get(id);
    const changedDate = new Date().toISOString();
    const existing = arr.findIndex((e) => e.rev === rev);
    if (existing >= 0) {
      arr[existing] = { rev, completedWork, changedDate, changedBy };
    } else {
      arr.push({ rev, completedWork, changedDate, changedBy });
      arr.sort((a, b) => a.rev - b.rev);
    }
  }

  /**
   * Applies a write (log hours / set progress) to one task and returns the
   * new values immediately, without waiting for a full resync.
   *
   * Two sources of staleness are fixed here:
   *
   * 1. Reporting-feed delay: ADO's bulk revision feed has eventual consistency,
   *    so a freshly-written revision might not appear there for several minutes.
   *    We inject it into the in-memory index right now so the next sync's
   *    `buildDailyHoursFromIndex` computes today's hours correctly without
   *    waiting for the feed to catch up.
   *
   * 2. Boundary-item inaccuracy: items with pre-INDEX_START_DATE history are
   *    "boundary-seeded" from the per-item `/updates` API into `updatesCache`.
   *    Deleting `updatesCache[id]` without also clearing `boundarySeeded`
   *    caused those items to permanently fall through to the index path, where
   *    `prev = 0` and the first indexed completedWork value become a spurious
   *    inflated delta. Clearing `boundarySeeded` forces a fresh `/updates` seed
   *    on the next sync — that API is consistent (no propagation delay) and
   *    will include the revision we just wrote.
   */
  async writeTaskHours(client, id, computeFn, person) {
    // The automatic state transitions that ride along with an hours write are
    // resolved from THIS project's real per-type workflows, not from hardcoded
    // Agile names — see server/ado/writeback.js and server/compute/workflow.js.
    const [states, types] = await Promise.all([this.ensureStates(), this.ensureTypes()]);
    // `types` carries each type's hours capability — an hours write to a type
    // without Completed Work is refused before any PATCH (007, TYPE_NO_HOURS).
    const result = await applyTaskWrite(client, id, computeFn, person.id, states, types);

    // Fix 1: make today's hours appear immediately in the next sync.
    const writerKey = person.uniqueName ? person.uniqueName.toLowerCase() : null;
    this._injectRevisionIntoIndex(id, result.rev, result.hours.completed, writerKey);

    // Fix 2: force boundary items to re-seed on next sync so pre-index
    // history remains accurate after the updatesCache entry is dropped.
    delete this.updatesCache[id];
    this.boundarySeeded.delete(id);
    this.cache.set('workItemUpdates', this.updatesCache);

    this._requestResyncFor(person);
    return result;
  }

  /**
   * Changes a work item's state directly (the manual state picker, not the
   * automatic transitions that ride along with an hours write). Same
   * pattern as writeTaskHours: apply, invalidate what's now stale, kick off
   * a background resync.
   */
  async writeState(client, id, newState, person) {
    const states = await this.ensureStates();
    const result = await applyStateWrite(client, id, newState, states);
    this._patchCachedWorkItems(person.id, [id], { state: newState });
    this._requestResyncFor(person);
    return result;
  }

  /**
   * Moves a task/bug onto its parent story's current iteration — the fix
   * for the "story moved sprints, its tasks got left behind" problem. The
   * target path is resolved server-side from the item's real parent in ADO,
   * never taken from the client. Same write pattern as writeState.
   */
  async writeIteration(client, id, person) {
    const result = await applyMoveToParentIteration(client, id, person.id);
    if (result.moved) {
      this._patchCachedWorkItems(person.id, [id], { iterationPath: result.iterationPath });
      this._requestResyncFor(person);
    }
    return result;
  }

  /**
   * Bulk equivalent of writeIteration: moves every one of a story's children
   * (tasks/bugs) that the caller owns and that aren't already on the
   * story's sprint. Partial failures don't prevent the ones that succeeded
   * from being reflected immediately — only the moved ids are patched into
   * the cache and only their presence triggers a resync.
   */
  async writeStoryChildrenIteration(client, storyId, person) {
    const result = await applyMoveChildrenToStoryIteration(client, storyId, person.id);
    if (result.moved.length > 0) {
      this._patchCachedWorkItems(person.id, result.moved, { iterationPath: result.iterationPath });
      this._requestResyncFor(person);
    }
    return result;
  }

  /**
   * Debounces the background resync that follows a write, per person: several
   * edits in quick succession (e.g. logging hours on a handful of tasks)
   * previously fired one full sync — hundreds of API calls — per edit, which
   * is exactly the kind of burst that trips Azure DevOps's per-identity rate
   * limiting. The optimistic client-side patch already reflects each write
   * instantly, so nothing is lost by waiting for the burst to settle before
   * actually hitting ADO again. Keyed per person (not a single shared timer)
   * so one person's write can't cancel another's pending resync now that
   * multiple people can be writing concurrently.
   *
   * Calls `syncPerson` with `{ force: true }` — without it, a sync that was
   * already running when the write happened (very likely: the client's 60s
   * poll routinely triggers the 5-minute stale revalidate in
   * GET /api/dashboard) would simply be *joined* instead of a new one being
   * started. That in-flight sync read Azure DevOps BEFORE this write, so its
   * result is stale, and joining it silently consumes the one scheduled
   * resync — nothing corrects the cache afterward until the next 15-minute
   * poll. `force: true` makes `syncPerson` chain a fresh sync after the
   * in-flight one instead (see the doc comment on `syncPerson`), which is
   * the only way to guarantee this resync actually reads post-write data.
   */
  _requestResyncFor(person) {
    const existing = this.resyncTimers.get(person.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.resyncTimers.delete(person.id);
      this.syncPerson(person, { force: true }).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[sync] post-write resync failed for ${person.displayName}:`, err.message);
      });
    }, SELF_RESYNC_DEBOUNCE_MS);
    timer.unref();
    this.resyncTimers.set(person.id, timer);
  }

  /** One background pass. Only ever targets the read token's own identity — a
   * full sync is hundreds of API calls, so polling every teammate is not
   * viable. Other people are synced on demand when selected in the picker.
   *
   * The interval timer lives in server/scopes.js rather than here: with one
   * engine per project it has to decide WHICH projects are worth polling (and
   * poll them one at a time, since ADO's rate budget is per token identity,
   * not per project). Never rejects — a failed poll is logged and the loop
   * continues. */
  pollOnce() {
    return this.getSelf()
      .then((self) => this.syncPerson({ ...self, isSelf: true }))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[sync] ${this.config.project}: sync failed:`, err.message);
      });
  }

  /** Releases everything that would otherwise outlive this engine — called
   * when a project scope is evicted (see server/scopes.js evictIdle). */
  dispose() {
    for (const timer of this.resyncTimers.values()) clearTimeout(timer);
    this.resyncTimers.clear();
    this.listeners.clear();
    this.cache.mem.clear();
  }
}

module.exports = { SyncEngine, groupByIteration };
