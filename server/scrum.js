/**
 * Per-scope Scrum orchestration — the third layer between raw ADO access
 * and pure compute, sibling to server/crossHours.js (see research.md R7).
 * One instance per project scope (server/scopes.js), reading the project's
 * own SyncEngine (revision index, discovered types/states/estimate field)
 * and caching per sprint in the project's own cache directory.
 *
 * Closed sprints are computed once and never invalidated (FR-008c): once a
 * sprint's status is 'past', its cache entry — once written — is served
 * forever, regardless of what a fresh computation over updated history
 * would now say. That is what makes server/compute/velocity.js's pure,
 * re-derivable-from-history-alone functions safe to call again later
 * without disturbing what was already shown for a closed sprint.
 */

const { DEFAULT_SPRINT_WINDOW, STAGE_PROGRESS_BY_CATEGORY } = require('./scrumConstants');
const { distributeStory, rollupSprint, averageOf } = require('./compute/velocity');
const { fetchSprintItems } = require('./ado/sprintItems');
const { stateCategoryOf } = require('./compute/rollup');
const { fetchAllCapacities } = require('./ado/capacity');
const { rollupUtilisation } = require('./compute/capacityRollup');
const { computeSprintProgress } = require('./compute/sprintProgress');
const { buildBurndown, dateRange } = require('./compute/burndown');
const { computeImpediments } = require('./compute/impediments');
const { computeScopeChange } = require('./compute/scopeChange');
const { emptyConvention, missingConfigRefs } = require('./blockedConvention');
const { fetchEligibleBlockedFields } = require('./ado/discovery');
const { INDEX_START_DATE } = require('./ado/revisionIndex');

// Sprint items, capacity, and impediments read current-value fields edited
// in ADO out of band (an owner reassigned, a tag removed) — a short TTL
// keeps the standup view fresh without a full request on every card open.
const SHORT_TTL_MS = 5 * 60 * 1000;

class ScrumEngine {
  constructor(config, cache, sync) {
    this.config = config;
    this.cache = cache;
    this.sync = sync;
    this.velocityInFlight = null;
    // Story titles for velocity (in-memory, id -> {title, at}). Velocity's
    // story set is project-wide and spans the whole window, not one sprint —
    // it doesn't fit the single-sprint scrum:items:<sprintPath> cache
    // (T013a) used by progress/impediments/scope-change, so it gets its own,
    // same SHORT_TTL_MS rule. Without this, every velocity request re-reads
    // every window story's title from ADO even though the numbers themselves
    // are cached, which was the whole gap between "computed" and "no
    // perceptible wait" on a return visit (SC-007b, FR-006e).
    this.titleCache = new Map();
  }

  /** Read-through title lookup for a set of story ids, fetching only what's
   * missing or stale (data-model.md §2a). */
  async _titlesFor(ids, estimateFieldName) {
    const now = Date.now();
    const stale = ids.filter((id) => {
      const hit = this.titleCache.get(id);
      return !hit || now - hit.at > SHORT_TTL_MS;
    });
    if (stale.length > 0) {
      const items = await fetchSprintItems(this.sync.client, stale, { estimateField: estimateFieldName || null });
      const foundIds = new Set();
      for (const item of items) {
        this.titleCache.set(item.id, { title: item.title, at: now });
        foundIds.add(item.id);
      }
      // An id ADO no longer returns (deleted, or off-project) still needs a
      // display fallback rather than being refetched forever.
      for (const id of stale) {
        if (!foundIds.has(id)) this.titleCache.set(id, { title: `#${id}`, at: now });
      }
    }
    const byId = new Map();
    for (const id of ids) byId.set(id, this.titleCache.get(id).title);
    return byId;
  }

  /** Cache.set writes `<key>.json` verbatim as a filename (server/cache.js),
   * and a sprint's IterationPath is a backslash-separated string like
   * "ProjectA\Sprint 78" — a raw colon-and-backslash key (as data-model.md
   * §9 names it conceptually: `scrum:velocity:<sprintPath>`) would either be
   * misread as a nested path or rejected outright on Windows, which this app
   * deploys on. encodeURIComponent keeps the key one filesystem-
   * safe segment; the mapping is deterministic and never collides between
   * two distinct sprint paths. */
  // A9 bumped the cached payload's own shape (shares trimmed to
  // disclosure-worthy ones) — versioning the KEY, not the value, is the
  // whole migration a disposable cache needs: an old v1 entry is simply
  // never read again under the v2 key, rather than being misread as
  // already-trimmed.
  _velocityCacheKey(sprintPath) {
    return `scrum-velocity-v2-${encodeURIComponent(sprintPath)}`;
  }

  /** A sprint is only safe to freeze once the revision index has actually
   * OBSERVED everything through that sprint's end — `sprint.status ===
   * 'past'` alone is a date comparison and says nothing about whether the
   * index (which refreshes incrementally, and can sit stale for months on a
   * project nobody has opened) has caught up that far yet.
   *
   * Without this check, the very first computation on a stale/cold index
   * would cache whatever incomplete answer it produced — commonly 0 — and
   * FR-008c's immutability rule would then protect that wrong answer
   * forever, even after the index catches up and the real data (e.g. a
   * story's estimate, added after the fact) becomes available. That is a
   * real incident, not a hypothetical: an index last refreshed months ago
   * produced and permanently cached zero velocity for six sprints before
   * this guard existed. Cache real fields (the revision index's own
   * watermark), not opinions — see the analogous "an empty PR fetch is
   * treated as a failure, not truth" guard in sync.js for the same posture
   * applied to a different index. */
  // A2: coverage must be checked at BOTH ends, not just the upper one. A
  // sprint that ended before INDEX_START_DATE trivially passes an
  // upper-bound-only check (the watermark is always >= a date that old), so
  // its genuinely-empty history (nothing in the index, not "nothing
  // happened") computes as 0/stable and FR-008c's immutability then
  // protects that WRONG zero forever — the same incident this guard exists
  // to prevent, reproduced at the other end of the range.
  _indexCoversSprintEnd(sprint) {
    return !!this.sync.revisionWatermark && sprint.startDate >= INDEX_START_DATE && this.sync.revisionWatermark >= sprint.finishDate;
  }

  _cachedVelocity(sprint) {
    if (sprint.status !== 'past' || !this._indexCoversSprintEnd(sprint)) return null; // not yet safe to freeze — always recompute
    return this.cache.get(this._velocityCacheKey(sprint.path)) || null;
  }

  _cacheVelocity(sprint, value) {
    if (sprint.status !== 'past' || !this._indexCoversSprintEnd(sprint)) return; // never persist an answer the index hadn't actually confirmed yet
    this.cache.set(this._velocityCacheKey(sprint.path), value);
  }

  /**
   * US1: per-sprint velocity + windowed average (FR-007 through FR-014).
   * Concurrent callers share one in-flight build — two open Velocity cards
   * must not each walk the whole story set at once.
   */
  async getVelocity({ windowSize = DEFAULT_SPRINT_WINDOW } = {}) {
    const key = `w:${windowSize}`;
    if (!this.velocityInFlight) this.velocityInFlight = new Map();
    const existing = this.velocityInFlight.get(key);
    if (existing) return existing;
    const promise = this._computeVelocity(windowSize).finally(() => this.velocityInFlight.delete(key));
    this.velocityInFlight.set(key, promise);
    return promise;
  }

  async _computeVelocity(windowSize) {
    const [types, states, estimateField] = await Promise.all([
      this.sync.ensureTypes(),
      this.sync.ensureStates(),
      this.sync.ensureEstimateField(),
    ]);

    if (!estimateField) {
      // FR-013a: no story-level estimate field on this project at all —
      // velocity is unavailable, never a zero-filled series.
      return { unit: null, unitAvailable: false, windowSize, sprints: [], average: null, averageIsContextOnly: true };
    }

    await this.sync.ensureRevisionIndex();
    const { sprints } = await this.sync.getSprints();
    // Only sprints that have actually started — a future sprint carries no
    // history to distribute yet.
    const started = sprints.filter((s) => s.status !== 'future');
    const windowSprints = started.slice(-windowSize);

    if (windowSprints.length === 0) {
      return { unit: estimateField.label, unitAvailable: true, windowSize, sprints: [], average: null, averageIsContextOnly: true };
    }

    const historySprints = started.filter((s) => s.startDate <= windowSprints[windowSprints.length - 1].startDate);
    const storyTypes = types.storyTypes;
    const storyIds = this.sync.getIdsByType(storyTypes);
    // A7: one children map PER sprint, each resolved as at that sprint's own
    // end — a task reparented later must not retroactively move its
    // already-closed-sprint hours to its new story. Precomputed once per
    // (small, window-bounded) sprint rather than once per story x sprint.
    const childrenMapsBySprint = new Map(historySprints.map((sp) => [sp.path, this.sync.getChildrenMap(sp.finishDate)]));

    const exclusionsByPath = new Map();
    const bumpExclusion = (path, field) => {
      if (!exclusionsByPath.has(path)) exclusionsByPath.set(path, { noEstimate: 0, noMeasurableWork: 0 });
      exclusionsByPath.get(path)[field] += 1;
    };

    const stories = [];
    for (const storyId of storyIds) {
      const storyRevs = this.sync.getRevisionsFor(storyId);
      if (storyRevs.length === 0) continue;
      const storyType = storyRevs[storyRevs.length - 1].workItemType;

      const perSprint = historySprints.map((sp) => {
        const childIds = childrenMapsBySprint.get(sp.path).get(storyId) || [];
        const itemIds = [storyId, ...childIds];
        let totalAtEnd = 0;
        let deltaCompleted = 0;
        let sawAny = false;
        for (const id of itemIds) {
          const completedEnd = this.sync.getFieldAt(id, 'completedWork', sp.finishDate);
          const remainingEnd = this.sync.getFieldAt(id, 'remainingWork', sp.finishDate);
          const completedStart = this.sync.getFieldAt(id, 'completedWork', sp.startDate);
          if (completedEnd != null || remainingEnd != null) sawAny = true;
          totalAtEnd += (completedEnd || 0) + (remainingEnd || 0);
          deltaCompleted += (completedEnd || 0) - (completedStart || 0);
        }
        const estimateAtEnd = this.sync.getFieldAt(storyId, 'estimate', sp.finishDate);
        return { sprintPath: sp.path, deltaCompleted, totalAtEnd: sawAny ? totalAtEnd : null, estimateAtEnd };
      });

      // The earliest indexed revision's rev number tells us whether the
      // story's real history starts here (rev === 1, true creation, so
      // "no earlier revision" genuinely means "didn't exist yet") or
      // predates the index (rev > 1 — the same boundary signal
      // SyncEngine.ensureBoundarySeeded uses for hours). For a boundary
      // story, a sprint whose END state is Completed is not by itself
      // proof the transition happened DURING that sprint — the item could
      // already have been closed before this window (or before
      // INDEX_START_DATE) and simply picked up an unrelated revision here.
      // Only a sprint whose START state is known and NOT already Completed
      // is real evidence the transition happened inside it.
      const trueOriginKnown = storyRevs[0].rev === 1;
      let completingSprintPath = null;
      for (const sp of historySprints) {
        const state = this.sync.getFieldAt(storyId, 'state', sp.finishDate);
        const category = stateCategoryOf(storyType, state, states);
        if (category !== 'Completed') continue;
        if (!trueOriginKnown) {
          const stateAtStart = this.sync.getFieldAt(storyId, 'state', sp.startDate);
          const categoryAtStart = stateCategoryOf(storyType, stateAtStart, states);
          if (categoryAtStart == null || categoryAtStart === 'Completed') continue; // no evidence of an in-sprint transition
        }
        completingSprintPath = sp.path;
        break;
      }

      const asOfDate = completingSprintPath
        ? historySprints.find((s) => s.path === completingSprintPath).finishDate
        : historySprints[historySprints.length - 1].finishDate;
      const finalEstimate = this.sync.getFieldAt(storyId, 'estimate', asOfDate);

      if (finalEstimate == null) {
        for (const sp of perSprint) {
          if (sp.deltaCompleted > 0 && windowSprints.some((w) => w.path === sp.sprintPath)) {
            bumpExclusion(sp.sprintPath, 'noEstimate');
          }
        }
        continue; // FR-013: excluded from the total, disclosed instead
      }

      // A3/FR-008e-iii: a story with a real estimate that has NEVER completed
      // and has NEVER had any measurable child/self work recorded (the same
      // `everMeasurable` test distributeStory itself uses for whole-credit)
      // contributes structurally nothing to any sprint in this window under
      // current rules — rather than silently carrying it through as an
      // all-zero row, it is excluded and disclosed exactly like the
      // no-estimate case above, so the exclusion count actually reflects
      // stories that were dropped rather than always reading zero.
      const everMeasurable = perSprint.some((sp) => sp.totalAtEnd != null && sp.totalAtEnd > 0);
      if (!completingSprintPath && !everMeasurable) {
        for (const sp of perSprint) {
          if (windowSprints.some((w) => w.path === sp.sprintPath)) bumpExclusion(sp.sprintPath, 'noMeasurableWork');
        }
        continue;
      }

      stories.push({ id: storyId, title: null, perSprint, completingSprintPath, finalEstimate });
    }

    // Titles come from the sprint item read (data-model.md §2a) — the index
    // carries no title at all. Cached read-through (_titlesFor) rather than
    // fetched fresh every call: unlike the per-sprint numbers, title lookups
    // weren't cached at all before, which meant every velocity request paid
    // a live ADO round trip for every window story regardless of how stale
    // its actual figures were (SC-007b, FR-006e).
    const titleById = stories.length ? await this._titlesFor(stories.map((s) => s.id), estimateField.field) : new Map();
    for (const s of stories) s.title = titleById.get(s.id) || `#${s.id}`;

    const allShares = stories.flatMap((s) => distributeStory(s));

    // FR-026a/FR-026b: who made progress on this sprint's stories (story +
    // descendants) without being on the org chart roster. Scoped per story
    // per window sprint — the same items and dates already used to compute
    // that story's deltaCompleted above, just asking WHO rather than HOW
    // MUCH — and only for windowSprints, since that's all rollupSprint ever
    // surfaces (the wider historySprints exist only to seed distribution).
    const rosterKeys = new Set(this._roster().map((m) => m.personKey));
    const offRosterBySprint = new Map();
    for (const s of stories) {
      for (const sp of windowSprints) {
        const childIds = childrenMapsBySprint.get(sp.path).get(s.id) || [];
        const itemIds = [s.id, ...childIds];
        const contributors = this.sync.getContributorsFor(itemIds, sp.startDate, sp.finishDate);
        for (const personKey of contributors) {
          if (rosterKeys.has(personKey)) continue;
          if (!offRosterBySprint.has(sp.path)) offRosterBySprint.set(sp.path, new Map());
          offRosterBySprint.get(sp.path).set(personKey, personKey);
        }
      }
    }

    const sprintVelocities = windowSprints.map((sp) => {
      const cached = this._cachedVelocity(sp);
      if (cached) return cached;
      const contributors = offRosterBySprint.get(sp.path);
      const offRoster = contributors ? [...contributors.keys()].map((personKey) => ({ personKey, displayName: personKey })) : [];
      const computed = rollupSprint(sp.path, allShares, {
        isProvisional: sp.status === 'current',
        exclusions: exclusionsByPath.get(sp.path) || { noEstimate: 0, noMeasurableWork: 0 },
        offRoster,
        unit: estimateField.label,
      });
      this._cacheVelocity(sp, computed);
      return computed;
    });

    return {
      unit: estimateField.label,
      unitAvailable: true,
      windowSize,
      sprints: sprintVelocities,
      average: averageOf(sprintVelocities),
      averageIsContextOnly: true,
    };
  }

  /** Resolves a `?sprint=` path to the sprint object, defaulting to the
   * sprint containing today (FR-003) when none is given or it's unknown. */
  async _resolveSprint(sprintPath) {
    const { sprints, currentPath } = await this.sync.getSprints();
    const path = sprintPath || currentPath;
    return sprints.find((s) => s.path === path) || null;
  }

  /** Every unique PERSON in the project's org chart (server/org.js) — the
   * roster US3/US5's off-roster checks compare against (FR-026), never an
   * ADO team. Folded by email since the store is keyed by membership (one
   * row per team someone belongs to). */
  _roster() {
    const store = this.sync.orgStore.getStore();
    const byEmail = new Map();
    for (const m of store.members) {
      if (!byEmail.has(m.email)) byEmail.set(m.email, { personKey: m.email, displayName: m.displayName });
    }
    return [...byEmail.values()];
  }

  /** The sprint's current item set (data-model.md §2a), shared by progress,
   * impediments, and scope-change so one sprint is fetched once
   * (data-model.md §9 `scrum:items:<sprintPath>`). Short TTL — these are
   * current values edited in ADO out of band. */
  async _getSprintItems(sprint) {
    const key = `scrum-items-${encodeURIComponent(sprint.path)}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < SHORT_TTL_MS) return cached.items;

    const [states, estimateField, convention] = await Promise.all([
      this.sync.ensureStates(),
      this.sync.ensureEstimateField(),
      this.getBlockedConvention(),
    ]);
    // A convention may name a different field per type (FR-035c-iii); this
    // read requests one field name per call, so where more than one distinct
    // field is configured across types, the first is used — a documented
    // simplification, since every project seen in practice configures the
    // same field (e.g. Microsoft.VSTS.CMMI.Blocked) for every type that uses
    // one at all.
    const fields = new Set(Object.values(convention.byType || {}).map((r) => r.field).filter(Boolean));
    const blockedField = fields.size > 0 ? [...fields][0] : null;

    const ids = this.sync.getIdsByIteration(sprint.path);
    const items = await fetchSprintItems(this.sync.client, ids, {
      estimateField: estimateField ? estimateField.field : null,
      blockedField,
      statesByType: states,
    });
    this.cache.set(key, { at: Date.now(), items });
    return items;
  }

  /**
   * US2: per-story sprint progress (FR-015 through FR-019).
   */
  async getProgress({ sprintPath } = {}) {
    const sprint = await this._resolveSprint(sprintPath);
    if (!sprint) return { stories: [], counts: { completed: 0, inProgress: 0, notStarted: 0 } };
    // Every read below (via _getSprintItems' getIdsByIteration, getChildrenMap,
    // and computeSprintProgress's getFieldAt) goes straight at the in-memory
    // revision index — only _computeVelocity awaited this build before; every
    // other view read whatever partial index happened to be in memory yet,
    // which on a cold/never-opened project silently returned empty results
    // (see the class-doc comment on _indexCoversSprintEnd for the same
    // failure mode already fixed for velocity's cache).
    await this.sync.ensureRevisionIndex();
    const { storyTypes } = await this.sync.ensureTypes();
    const items = await this._getSprintItems(sprint);
    const storyItems = items.filter((i) => storyTypes.includes(i.type));
    const childrenMap = this.sync.getChildrenMap();
    const today = new Date().toISOString();
    return computeSprintProgress(storyItems, childrenMap, this.sync, today);
  }

  /**
   * US3: per-person utilisation (FR-020 through FR-026a).
   */
  async getUtilisation({ sprintPath } = {}) {
    const sprint = await this._resolveSprint(sprintPath);
    if (!sprint) return { members: [], summary: { membersWithKnownAvailability: 0, membersExcluded: 0 }, allUnknown: false, offRoster: [] };

    await this.sync.ensureRevisionIndex(); // getLoggedHoursInRange reads the index directly
    const key = `scrum-capacity-${encodeURIComponent(sprint.path)}`;
    const cached = this.cache.get(key);
    let capacityRecords;
    if (cached && Date.now() - cached.at < SHORT_TTL_MS) {
      capacityRecords = cached.records;
    } else {
      capacityRecords = await fetchAllCapacities(this.sync.client, this.config.projectId, sprint.id, sprint);
      this.cache.set(key, { at: Date.now(), records: capacityRecords });
    }

    const roster = this._roster();
    const loggedHoursByPerson = this.sync.getLoggedHoursInRange(sprint.startDate, sprint.finishDate);
    // 006-linked-identity-aliases (T032, US2 scenario 2): a migrated roster
    // member's hours can be split across two keys in loggedHoursByPerson —
    // their retired identity's changedBy and their current one's. Without
    // this, rollupUtilisation (which reads ONLY `m.personKey`) would show
    // them under-logged rather than as one correct row. Mutates a COPY of
    // the map, never the one getLoggedHoursInRange just built — that map is
    // this call's own, but copying keeps the merge's intent explicit rather
    // than relying on it being freshly built every call.
    const mergedHours = await this._mergeLinkedIdentityHours(roster, loggedHoursByPerson);
    return rollupUtilisation(roster, capacityRecords, mergedHours);
  }

  /**
   * For every roster member, folds any OTHER identity in their identity set
   * (server/identitySet.js) into their own `personKey` entry in `hoursMap` —
   * see the call site above. A person with a single identity (the common
   * case) costs nothing beyond the identity-set lookup itself, which is
   * already 24h-cached per person (SyncEngine.ensureIdentitySet).
   */
  async _mergeLinkedIdentityHours(roster, hoursMap) {
    if (roster.length === 0) return hoursMap;
    const merged = new Map(hoursMap);
    await Promise.all(
      roster.map(async (m) => {
        const identities = await this.sync.getIdentitySetForEmail(m.personKey).catch(() => null);
        if (!identities || identities.linked.length === 0) return;
        let extra = 0;
        for (const linked of identities.linked) {
          const key = linked.uniqueName;
          // hoursMap is keyed by the RAW changedBy string the revision index
          // recorded, which may not share personKey's casing — try both the
          // exact and lowercased form rather than assuming one.
          const matchedKey = merged.has(key) ? key : merged.has(key.toLowerCase()) ? key.toLowerCase() : null;
          if (matchedKey) {
            extra += merged.get(matchedKey);
            // Delete, not leave at 0: the off-roster fold below only adds an
            // entry when `hours > 0`, but leaving this key present with any
            // value would still let the SAME hours show up a second time as
            // a phantom off-roster contributor under the retired identity's
            // raw address, alongside the now-correct roster row.
            merged.delete(matchedKey);
          }
        }
        if (extra > 0) merged.set(m.personKey, (merged.get(m.personKey) || 0) + extra);
      })
    );
    return merged;
  }

  _burndownCacheKey(sprintPath) {
    return `scrum-burndown-${encodeURIComponent(sprintPath)}`;
  }

  /**
   * US4: remaining-work burndown (FR-029 through FR-034).
   */
  async getBurndown({ sprintPath } = {}) {
    const sprint = await this._resolveSprint(sprintPath);
    if (!sprint) return { points: [], tracked: false, todayIndex: -1 };

    await this.sync.ensureRevisionIndex();

    if (sprint.status === 'past' && this._indexCoversSprintEnd(sprint)) {
      const cached = this.cache.get(this._burndownCacheKey(sprint.path));
      if (cached) return cached;
    }

    const { storyTypes } = await this.sync.ensureTypes();
    const storyIds = this.sync.getIdsByType(storyTypes);
    const childrenMap = this.sync.getChildrenMap();
    const idsInSprint = new Set(this.sync.getIdsByIteration(sprint.path));
    // A story currently outside the sprint may still have contributed to it
    // earlier; burndown, like the rest of this feature, reads the CURRENT
    // membership only — a documented approximation shared with impediments.
    const relevantStoryIds = storyIds.filter((id) => idsInSprint.has(id));
    const allIds = new Set(relevantStoryIds);
    for (const id of relevantStoryIds) for (const c of childrenMap.get(id) || []) allIds.add(c);

    let trackedAnywhere = false;
    for (const id of allIds) {
      if (this.sync.getRevisionsFor(id).some((r) => r.remainingWork != null)) {
        trackedAnywhere = true;
        break;
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const dates = dateRange(sprint.startDate.slice(0, 10), sprint.finishDate.slice(0, 10));
    const remainingByDate = dates.map((d) => {
      // getFieldAt('date') means "as of the latest revision at or before
      // `date`" — passing the bare YYYY-MM-DD date string (implicit
      // T00:00:00.000Z) reads the value as of the START of that day, not
      // its end, so every day's point (including today's) never reflects
      // that day's own work, and day 0 reads as the value BEFORE the
      // sprint's first day of activity. Reading as of the end of the
      // calendar day is what "remaining work on day D" actually means here.
      let sum = 0;
      for (const id of allIds) sum += this.sync.getFieldAt(id, 'remainingWork', `${d}T23:59:59.999Z`) || 0;
      return sum;
    });

    const result = buildBurndown(dates, remainingByDate, trackedAnywhere, today);
    if (sprint.status === 'past' && this._indexCoversSprintEnd(sprint)) {
      this.cache.set(this._burndownCacheKey(sprint.path), result);
    }
    return result;
  }

  // --- US5: blocked convention + impediments -------------------------------

  /** Reads the project's configured blocked convention, defaulting to empty
   * (never guessed — FR-035d-i). Persisted via server/orgStore.js alongside
   * the org chart. */
  async getBlockedConvention() {
    await this.sync.ensureRoles(); // ensures the org store is loaded at least once
    const store = this.sync.orgStore.getStore();
    return store.blockedConvention || emptyConvention();
  }

  /** Called right after a successful convention save (PUT
   * /api/scrum/blocked-convention) so the standup view reflects it
   * immediately rather than for up to SHORT_TTL_MS. Both `scrum-items-*`
   * (which requests the convention's own blocked field alongside the base
   * fields) and `scrum-impediments-*` (which matches against the convention
   * directly) are keyed per sprint, so every sprint's entry is cleared —
   * there is no cheap way to know in advance which sprints a project-wide
   * convention change actually affects. */
  invalidateConventionDependentCaches() {
    for (const key of this.cache.keys()) {
      if (key.startsWith('scrum-items-') || key.startsWith('scrum-impediments-')) this.cache.delete(key);
    }
  }

  /**
   * US5: blocked + stalled items (FR-035 through FR-040).
   */
  async getImpediments({ sprintPath } = {}) {
    const sprint = await this._resolveSprint(sprintPath);
    if (!sprint) return { items: [], conventionConfigured: false, missingConfigRefs: [] };

    const key = `scrum-impediments-${encodeURIComponent(sprint.path)}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < SHORT_TTL_MS) return cached.value;

    await this.sync.ensureRevisionIndex(); // getIdsByIteration/getRevisionsFor read the index directly
    const convention = await this.getBlockedConvention();
    const items = await this._getSprintItems(sprint);
    const today = new Date().toISOString();
    const { items: impedimentItems } = computeImpediments(items, convention, (id) => this.sync.getRevisionsFor(id), today);
    const conventionConfigured = Object.keys(convention.byType || {}).length > 0;

    const [types, states, fields] = await Promise.all([
      this.sync.ensureTypes(),
      this.sync.ensureStates(),
      fetchEligibleBlockedFields(this.sync.client),
    ]);
    const options = {
      types: types.allTypes,
      statesByType: states,
      tags: [...new Set(items.flatMap((i) => i.tags))],
      fields,
    };
    const value = { items: impedimentItems, conventionConfigured, missingConfigRefs: missingConfigRefs(convention, options) };
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  // --- US6: scope change -----------------------------------------------------

  _scopeChangeCacheKey(sprintPath) {
    return `scrum-scope-${encodeURIComponent(sprintPath)}`;
  }

  /**
   * US6: sprint scope change (FR-041 through FR-045a).
   */
  async getScopeChange({ sprintPath } = {}) {
    const sprint = await this._resolveSprint(sprintPath);
    if (!sprint) return { determinable: false, baselineDate: null, sizeAtStart: 0, sizeAtEnd: 0, net: 0, endIsProvisional: false, unestimatedCount: 0, events: [] };

    await this.sync.ensureRevisionIndex();

    if (sprint.status === 'past' && this._indexCoversSprintEnd(sprint)) {
      const cached = this.cache.get(this._scopeChangeCacheKey(sprint.path));
      if (cached) return cached;
    }

    // A5: a sprint that started before INDEX_START_DATE has no real history
    // in the index — not "nothing changed". Checking only `revisionWatermark`
    // (always truthy once any sync has run) let such a sprint fall through
    // to the normal computation, which then confidently reports "stable,
    // 0 -> 0" from an index that was simply never asked about that far back
    // (FR-045a forbids exactly this: absence of evidence as evidence of
    // stability).
    if (!this.sync.revisionWatermark || sprint.startDate < INDEX_START_DATE) {
      return { determinable: false, baselineDate: sprint.startDate, sizeAtStart: 0, sizeAtEnd: 0, net: 0, endIsProvisional: sprint.status !== 'past', unestimatedCount: 0, events: [] };
    }

    const { storyTypes } = await this.sync.ensureTypes();
    const storyIds = this.sync.getIdsByType(storyTypes);
    const items = await this._getSprintItems(sprint);
    const titleById = new Map(items.map((i) => [i.id, i.title]));
    const states = await this.sync.ensureStates();

    const stories = storyIds.map((id) => {
      const revisions = this.sync.getRevisionsFor(id);
      return {
        id,
        title: titleById.get(id) || `#${id}`,
        revisions,
        categoryAt: (date) => {
          const state = this.sync.getFieldAt(id, 'state', date);
          const type = this.sync.getFieldAt(id, 'workItemType', date);
          return stateCategoryOf(type, state, states);
        },
      };
    });

    const today = new Date().toISOString();
    let result = computeScopeChange(stories, sprint, (id, field, date) => this.sync.getFieldAt(id, field, date), today);

    // A12: a departed story is, by definition, absent from the current
    // sprint's own item set — `_getSprintItems` never has its title, so it
    // fell back to a bare `#id`, exactly on the rows a scope-change reviewer
    // most wants named. Resolve titles for just the ids scope-change events
    // actually name (a small, targeted set) through the same project-scoped,
    // System.TeamProject-re-checked batch read every other title comes from
    // — no new ADO query shape, just a second, smaller call.
    const missingIds = [...new Set(result.events.filter((e) => !titleById.has(e.storyId)).map((e) => e.storyId))];
    if (missingIds.length > 0) {
      const extraItems = await fetchSprintItems(this.sync.client, missingIds);
      const extraTitleById = new Map(extraItems.map((i) => [i.id, i.title]));
      result = {
        ...result,
        events: result.events.map((e) => (extraTitleById.has(e.storyId) ? { ...e, title: extraTitleById.get(e.storyId) } : e)),
      };
    }

    if (sprint.status === 'past' && this._indexCoversSprintEnd(sprint)) {
      this.cache.set(this._scopeChangeCacheKey(sprint.path), result);
    }
    return result;
  }
}

module.exports = { ScrumEngine, STAGE_PROGRESS_BY_CATEGORY };
