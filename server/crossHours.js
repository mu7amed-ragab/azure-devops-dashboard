/**
 * Cross-project hours — one person's logged hours summed over EVERY project
 * their token can read, with each hour still traceable to the project (and
 * work item) it came from.
 *
 * Why this is a separate engine rather than a flag on SyncEngine: a
 * SyncEngine is per project by construction (server/scopes.js), and the whole
 * point here is to span them. So this walks the project registry instead,
 * borrowing each scope's already-built revision index and adding nothing to
 * what any one scope knows.
 *
 * ---------------------------------------------------------------------------
 * How the hours are attributed, and why no WIQL is involved
 * ---------------------------------------------------------------------------
 * Every scope keeps a project-wide revision index (server/ado/revisionIndex.js):
 * for every work item in the project, every revision's CompletedWork value and
 * WHO made that revision (`changedBy`, v2 of the index). The per-project
 * dashboard card feeds that index the ids of the person's own assigned tree
 * and then filters deltas by `changedBy`.
 *
 * Here the ids come from the index itself — every item carrying at least one
 * revision by this person — which costs zero ADO requests and is the more
 * honest question anyway across projects: "hours I logged", not "hours logged
 * on items currently assigned to me". For the signed-in project the two agree
 * on everything the dashboard shows, because a person logging hours on a task
 * is a revision by them on that task either way; they can differ only for an
 * item that was later reassigned away from them, where this view keeps the
 * hours and the per-project card drops them.
 *
 * COST. The expensive part is a project's first revision-index build (a full
 * walk of its revision feed, ~1-2 min), which is the same work opening that
 * project in the dashboard would do, cached to disk afterwards and refreshed
 * incrementally. That is why this is a JOB (see `request` below) rather than a
 * plain request/response: the first cross-project build of N cold projects can
 * take minutes, and an HTTP request that hangs that long is indistinguishable
 * from a broken one.
 *
 * Projects are visited SEQUENTIALLY, for the same reason server/scopes.js
 * polls them that way: ADO's rate budget is per token identity, so N parallel
 * cold index walks under one PAT would throttle each other. For the same
 * reason whole BUILDS are serialised too (see `_start`): the Team page can
 * ask for several teammates' cross-project hours at once, and two concurrent
 * walks under one PAT would only throttle one another.
 *
 * ---------------------------------------------------------------------------
 * Viewer vs person: whose hours, read with whose token
 * ---------------------------------------------------------------------------
 * These are two different people on the Team page. The VIEWER is the caller —
 * their PAT is what lists the projects and opens each scope, and their
 * identity is what a scope's read-token election records as the owner of a
 * user token (server/scopes.js electReadToken), so the viewer's identity must
 * never be swapped for the person's. The PERSON is only ever a filter: whose
 * `changedBy` the revision deltas are counted for.
 *
 * The consequence, and it is stated in the payload rather than hidden: the
 * projects walked are the ones the VIEWER can read. A teammate who logs hours
 * in a project the viewer has no access to has those hours missing from this
 * answer — they are not "skipped" (nothing failed), they were never listed.
 * `viewer` on the result is what lets the UI say so.
 */

const { AdoClient } = require('./ado/client');
const { listProjects } = require('./ado/projects');
const { fetchWorkItemTitles } = require('./ado/workitems');
const { buildDailyHoursFromIndex, buildTimeline, dayKey } = require('./compute/timeline');

/** How long a built result is served without rebuilding. A rebuild is cheap
 * once every project's index exists (an incremental top-up each), but it is
 * still N sequential ADO round trips, so it is not done per page load. */
const FRESH_MS = 10 * 60 * 1000;

/** Days the breakdown covers — the same window `buildTimeline` fills into
 * `last7Days`, since that is what the UI can actually open. */
const BREAKDOWN_DAYS = 7;

function safeId(id) {
  return String(id).replace(/[^a-z0-9-]/gi, '');
}

/**
 * Keyed by BOTH people, not just whose hours these are: the same person's
 * total differs by who asked, because the walk only covers the projects the
 * viewer's token can list. Sharing one entry would let a viewer with narrower
 * access serve a truncated total to a viewer with broader access (and back).
 * The duplicate work is small — the expensive part, each project's revision
 * index, is held by the scope and shared by every build.
 */
function cacheKey(viewerId, personId) {
  return `cross-hours-v2-${safeId(viewerId)}--${safeId(personId)}`;
}

/** The last N day keys ending today (UTC), matching buildTimeline's window. */
function windowDayKeys(now, n) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

/**
 * Every work item id in `index` with at least one revision made by
 * `personKey`. Entries with no resolvable `changedBy` are included too, which
 * mirrors buildDailyHoursFromIndex's own fallback — it counts a delta whose
 * author is unknown rather than silently dropping real hours, so excluding
 * those ids here would make the two disagree.
 */
/**
 * 006-linked-identity-aliases: `personKey` accepts either a single
 * lowercased uniqueName (unchanged) or a `Set` of them — mirrors
 * `matchesPersonKey` in compute/timeline.js exactly (kept as a small local
 * copy rather than an import, since this file already has no dependency on
 * compute/timeline.js and the comparison is two lines).
 */
function matchesKey(personKey, candidateKey) {
  if (!personKey) return true;
  if (personKey instanceof Set) return personKey.has(candidateKey);
  return personKey === candidateKey;
}

function idsTouchedBy(index, personKey) {
  const ids = [];
  for (const [id, revs] of index) {
    for (const rev of revs) {
      if (!rev.changedBy || matchesKey(personKey, rev.changedBy)) {
        ids.push(id);
        break;
      }
    }
  }
  return ids;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

class CrossHours {
  /**
   * @param {object} deps
   * @param {ReturnType<import('./scopes').createScopeRegistry>} deps.registry
   * @param {object} deps.config the base config (org, api version, cacheDir…)
   * @param {import('./cache').Cache} deps.cache where built results are
   *   persisted — the registry's ORG-wide cache, because this answer is about
   *   a person across projects and belongs to no single project's directory.
   * @param {(client: AdoClient) => Promise<Array<{id:string,name:string}>>} [deps.listProjects]
   *   injectable so the whole cross-project walk can be driven offline in
   *   test/crossHours.test.js — the default is the real org-scoped call.
   */
  constructor({ registry, config, cache, listProjects: listProjectsFn = listProjects }) {
    this.registry = registry;
    this.config = config;
    this.cache = cache;
    this.listProjects = listProjectsFn;
    /** cacheKey(viewer, person) -> { promise, progress } while a build runs. */
    this.jobs = new Map();
    /** Tail of the serialised build queue — see `_start`. */
    this.chain = Promise.resolve();
  }

  /**
   * `person`'s cross-project hours as seen by `viewer`, building them if
   * needed.
   *
   * Returns either `{ status: 'building', progress }` or `{ status: 'ready',
   * … }`. A result past FRESH_MS is still returned immediately (marked
   * `stale`) while a rebuild runs behind it — the numbers on screen are never
   * replaced by a spinner once they exist.
   *
   * @param {{id: string, displayName: string, uniqueName: string, pat: string}} viewer
   *   the caller: the token every project is listed and read with.
   * @param {{id: string, displayName: string, uniqueName: string}} [person]
   *   whose hours to count. Defaults to the viewer — the Dashboard's case.
   */
  request(viewer, person = viewer) {
    const key = cacheKey(viewer.id, person.id);
    const cached = this.cache.get(key);
    const fresh = cached && Date.now() - cached.builtAt < FRESH_MS;
    if (!fresh) this._start(viewer, person);
    if (cached) {
      return { status: 'ready', stale: !fresh, ...cached };
    }
    const job = this.jobs.get(key);
    return { status: 'building', progress: job ? job.progress : null };
  }

  _start(viewer, person = viewer) {
    const key = cacheKey(viewer.id, person.id);
    const existing = this.jobs.get(key);
    if (existing) return existing.promise;

    const job = { progress: { done: 0, total: null, project: null, queued: true }, promise: null };
    // Queued behind whatever build is already running rather than started
    // now: the Team page opens several members at once, and each build is a
    // sequential walk of every project under ONE token's rate budget.
    // `queued: true` until this one's turn comes, so the UI can say "waiting"
    // instead of showing a progress bar pinned at zero.
    job.promise = this.chain
      .then(() => {
        job.progress.queued = false;
        return this._build(viewer, person, job);
      })
      .then((result) => {
        this.cache.set(key, result);
        return result;
      })
      .catch((err) => {
        // Swallowed on purpose: the poller asks again, and a transient ADO
        // failure mid-walk shouldn't leave a rejected promise unhandled.
        job.error = err.message;
        return null;
      })
      .finally(() => {
        this.jobs.delete(key);
      });
    // The chain must never carry a rejection forward, or one failed build
    // would sink every build queued behind it — job.promise already swallows.
    this.chain = job.promise;
    this.jobs.set(key, job);
    return job.promise;
  }

  async _build(viewer, person, job) {
    // 006-linked-identity-aliases (T035): widens from one lowercased
    // uniqueName to the whole identity set's keys, same as sync.js's own
    // _runSyncPass — a revision has exactly one changedBy, so Set
    // membership counts each one once regardless of which of the person's
    // identities made it. `person.identities` may be absent (a caller that
    // predates this feature, or the identity-set lookup degraded) — falls
    // back to the single-key form unchanged.
    const personKey = person.identities ? person.identities.keys : person.uniqueName ? person.uniqueName.toLowerCase() : null;
    // The VIEWER's identity, never the person's: this is who the PAT belongs
    // to, and a scope may record it as the owner of an elected read token.
    const identity = { id: viewer.id, displayName: viewer.displayName, uniqueName: viewer.uniqueName };
    const credentials = { pat: viewer.pat, identity };

    const projects = await this.listProjects(new AdoClient({ ...this.config, pat: viewer.pat }));
    job.progress.total = projects.length;

    const mergedDaily = new Map();
    /** dayKey -> Map<`${projectName}#${id}`, {id, projectName, hours}> */
    const windowItems = new Map();
    const windowDays = new Set(windowDayKeys(new Date(), BREAKDOWN_DAYS));
    const perProject = [];
    const skipped = [];

    for (const project of projects) {
      job.progress.project = project.name;
      let scope;
      try {
        scope = await this.registry.getScope(project, credentials);
      } catch (err) {
        // Listed but not readable with this token (Project and Team (Read) is
        // enough to be listed; work items need more) — reported, not fatal.
        skipped.push({ name: project.name, reason: 'no-access' });
        job.progress.done += 1;
        continue;
      }
      // Nothing may evict this scope out from under the walk below.
      const release = this.registry.retain(scope);
      try {
        await scope.sync.ensureRevisionIndex();
        const ids = idsTouchedBy(scope.sync.revisionIndex, personKey);
        if (ids.length > 0) {
          // Same one-time correction the per-project card applies: an item
          // whose history starts before the index window would otherwise
          // count its entire pre-window total as one day's work.
          await scope.sync.ensureBoundarySeeded(ids);
          const { daily, perItem } = buildDailyHoursFromIndex(
            scope.sync.revisionIndex,
            ids,
            scope.sync.updatesCache,
            personKey
          );
          let projectTotal = 0;
          for (const [day, hours] of daily) {
            mergedDaily.set(day, (mergedDaily.get(day) || 0) + hours);
            projectTotal += hours;
          }
          for (const [day, byId] of perItem) {
            if (!windowDays.has(day)) continue;
            let bucket = windowItems.get(day);
            if (!bucket) {
              bucket = new Map();
              windowItems.set(day, bucket);
            }
            for (const [id, hours] of byId) {
              if (hours <= 0) continue; // corrections stay hidden, as in buildBreakdown
              bucket.set(`${project.name}#${id}`, { id, projectName: project.name, hours });
            }
          }
          if (projectTotal > 0) perProject.push({ name: project.name, hours: round2(projectTotal) });
        }
      } catch (err) {
        skipped.push({ name: project.name, reason: 'error' });
      } finally {
        release();
        job.progress.done += 1;
      }
    }

    const timeline = buildTimeline(mergedDaily);
    timeline.breakdown = await this._buildBreakdown(windowItems, timeline.last7Days);

    return {
      builtAt: Date.now(),
      // Who these hours are about, and whose access decided which projects
      // were even looked at — the client renders both (a teammate's card says
      // so, and says the total covers the projects YOU can read).
      person: { id: person.id, displayName: person.displayName },
      self: person.id === viewer.id,
      timeline,
      // Only projects the person actually logged hours in — a list of every
      // project they can merely read would be noise, not information.
      projects: perProject.sort((a, b) => b.hours - a.hours),
      projectsScanned: projects.length,
      skipped,
    };
  }

  /**
   * Titles and types for the drill-down, fetched per project for just the ids
   * that appear in the visible window (a handful), not for everything walked.
   * An id that can't be resolved falls back to `#id`, exactly as the
   * per-project breakdown does.
   */
  async _buildBreakdown(windowItems, days) {
    /** projectName -> Set<id> */
    const byProject = new Map();
    for (const bucket of windowItems.values()) {
      for (const entry of bucket.values()) {
        if (!byProject.has(entry.projectName)) byProject.set(entry.projectName, new Set());
        byProject.get(entry.projectName).add(entry.id);
      }
    }

    /** `${projectName}#${id}` -> {title, type} */
    const lookup = new Map();
    for (const [projectName, ids] of byProject) {
      // By name, not registry.peek: scopes are keyed by GUID where one exists,
      // so a name-only peek would miss the very scope this walk just used.
      const scope = this.registry.list().find((s) => s.project.name === projectName);
      if (!scope) continue;
      try {
        const items = await fetchWorkItemTitles(scope.sync.client, [...ids]);
        for (const item of items) lookup.set(`${projectName}#${item.id}`, item);
      } catch (err) {
        // titles are cosmetic — the hours are already correct without them
      }
    }

    const breakdown = {};
    for (const { date } of days) {
      const bucket = windowItems.get(date);
      const entries = [];
      if (bucket) {
        for (const [key, entry] of bucket) {
          const item = lookup.get(key);
          entries.push({
            id: entry.id,
            title: item ? item.title : `#${entry.id}`,
            type: item ? item.type : 'Unknown',
            hours: round2(entry.hours),
            project: entry.projectName,
          });
        }
        entries.sort((a, b) => b.hours - a.hours);
      }
      breakdown[date] = entries;
    }
    return breakdown;
  }
}

module.exports = { CrossHours, idsTouchedBy, windowDayKeys };
