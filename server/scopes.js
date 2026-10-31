const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Cache } = require('./cache');
const { SyncEngine } = require('./sync');
const { ScrumEngine } = require('./scrum');
const { AdoClient } = require('./ado/client');

/**
 * One dashboard, N Azure DevOps projects.
 *
 * Everything that used to be process-global — the AdoClient, the SyncEngine
 * and all of its un-namespaced state (identity, iteration map, roster,
 * workflow states, roles, revision index), the disk cache, the org chart — is
 * now per project, held in a "scope". A person's session says which project
 * they picked at sign-in (see POST /api/auth/project) and every request is
 * served out of that project's scope.
 *
 * Two decisions worth knowing:
 *
 * 1. Each scope gets its own cache DIRECTORY rather than a project prefix on
 *    every cache key. server/cache.js makes the key the filename, so a
 *    directory swap needs no changes to any key in sync.js — and it means
 *    SyncEngine.clearCache's readdir-and-unlink loop, and _runFullResync's
 *    `dashboard-<version>-` prefix scan, are project-scoped for free instead
 *    of silently reaching into another project's data.
 *
 * 2. Scopes are lazy and evictable. A cold one costs a full revision-index
 *    build (the expensive part of a first sync), and the resident memory is
 *    dominated by that index, so at most `maxProjectScopes` stay in memory and
 *    idle ones are dropped. Disk state stays behind, so re-opening a project
 *    repaints from it instead of rebuilding.
 *
 * ---------------------------------------------------------------------------
 * Scoping audit — every Azure DevOps data source in this app, and why
 * ---------------------------------------------------------------------------
 * PROJECT-scoped (goes through AdoClient.projectUrl, or names the project
 * explicitly, and is cached in the scope's own directory):
 *
 *   work items / stories / tasks / bugs   ado/workitems.js — by an explicit
 *                                         [System.TeamProject] clause on EVERY
 *                                         query, and only by that. WIQL is
 *                                         org-scoped; the project in the
 *                                         request URL does nothing. Two of the
 *                                         three queries were missing the clause
 *                                         and returned org-wide results (356
 *                                         items in both projects, measured) —
 *                                         see teamProjectClause there.
 *   work item TYPES                       ado/workItemTypes.js — discovered per
 *                                         project, so Scrum/Basic/CMMI/custom
 *                                         template names are never assumed
 *   EVERY work item type (+ states,       ado/workItemTypes.js fetchEveryType —
 *     hours capability)                   GET /wit/workitemtypes through
 *                                         AdoClient.projectUrl, cached in this
 *                                         scope's own dir (`types-v2`); 007
 *   work item STATES                      ado/states.js, per discovered type
 *   Blocked-signal detection              ado/discovery.js detectBlockedSignal
 *   iterations / sprints / areas          ado/iterations.js (classificationnodes)
 *   revision index (hours history)        ado/revisionIndex.js (the reporting
 *                                         feed is per project)
 *   people / teams roster                 ado/people.js (projects/{p}/teams +
 *                                         a System.TeamProject WIQL clause)
 *   teams / roles / org chart             orgStore.js on `<project>.wiki` —
 *                                         the storage LOCATION is the scoping,
 *                                         which is why org.js has no projectId
 *   writeback (hours/state/iteration)     ado/writeback.js, validated against
 *                                         this project's own workflows
 *   revision index v3 fields              ado/revisionIndex.js — RemainingWork,
 *                                         State, IterationPath, the discovered
 *                                         estimate field, and Parent are the
 *                                         SAME per-project reporting feed as
 *                                         CompletedWork; no new endpoint.
 *   estimate field discovery              ado/estimateField.js — probes THIS
 *                                         project's own requirement type(s)
 *   sprint work-item detail read          ado/sprintItems.js — POST
 *                                         /wit/workitemsbatch, RE-CHECKED
 *                                         against System.TeamProject before
 *                                         use. Mandatory, not defensive: this
 *                                         endpoint returns any item the token
 *                                         can see even through a project-scoped
 *                                         URL (see the PR-attribution entry
 *                                         above, which relies on exactly that
 *                                         behaviour) — a hazard here since the
 *                                         Scrum page must never show another
 *                                         project's item in this project's
 *                                         sprint.
 *   past-ownership search                 ado/workitems.js queryEverAssigned —
 *                                         teamProjectClause on the WIQL, same
 *                                         as every other query in that file,
 *                                         PLUS a re-check of every hydrated
 *                                         result's System.TeamProject before
 *                                         it's normalized (SyncEngine.
 *                                         searchEverAssigned) — the same
 *                                         mandatory-not-defensive filter
 *                                         sprintItems.js applies above, for
 *                                         the same /wit/workitemsbatch
 *                                         cross-project-visibility reason.
 *                                         GET /api/workitems/search
 *                                         (005-search-history-sprint-
 *                                         placement).
 *   (Team capacity (US3) and the blocked convention (US5) are not yet built —
 *   see the feature's follow-up passes.)
 *
 * ORG-scoped, deliberately, because the fact itself is not about a project:
 *
 *   connectionData (who is this token)    ado/discovery.js getIdentity. An
 *                                         identity is an org-level fact; the
 *                                         same person is the same person in
 *                                         every project.
 *   project list                          ado/projects.js — this IS the
 *                                         "which projects may I pick" query
 *   IdentityPicker directory search       ado/identityPicker.js. Resolves an
 *                                         email on the org chart to an ADO
 *                                         identity. Confers no access to any
 *                                         project's data: the resolved person
 *                                         is only ever used as a parameter to
 *                                         the project-scoped queries above, so
 *                                         a hit here reveals nothing beyond
 *                                         "this email exists in the directory".
 *   identity-set discovery                identitySet.js resolveIdentitySet,
 *                                         via ado/identityPicker.js
 *                                         findIdentitiesByLocalPart (006-
 *                                         linked-identity-aliases). Same
 *                                         reasoning as the entry above, one
 *                                         level up: it names OTHER identities
 *                                         sharing the signed-in person's
 *                                         username (e.g. a retired-domain
 *                                         account), and confers no project
 *                                         read access of its own — every read
 *                                         that widens to the resulting set
 *                                         (sync.js, crossHours.js, scrum.js)
 *                                         still goes through THIS scope with
 *                                         the caller's own token, so a linked
 *                                         identity can surface at most what
 *                                         that token could already read.
 *                                         Resolved lazily on first use per
 *                                         scope (never awaited by
 *                                         POST /api/auth/project) and cached
 *                                         24h alongside `discovery`, in this
 *                                         scope's own Cache directory.
 *   PULL REQUESTS                         ado/pullrequests.js, and the ONE
 *                                         deliberate exception among the
 *                                         app's own views. A story ships across
 *                                         repositories that don't all live in
 *                                         its own project, so a project-scoped
 *                                         PR list is an incomplete answer to
 *                                         "what shipped this story" and an
 *                                         unsearchable one. Read that file's
 *                                         module comment before changing it.
 *                                         Cross-project PRs are LABELLED in the
 *                                         UI with their own projectName rather
 *                                         than silently mixed in.
 *   PR -> work item attribution           ado/prAttribution.js. Resolves across
 *                                         projects, which is what makes the
 *                                         above useful: /wit/workitemsbatch
 *                                         reads a work item from any project the
 *                                         token can see, even through a
 *                                         project-scoped URL (verified live).
 *   PR attribution candidate cache        .cache/_org/ — shared, because a PR is
 *                                         the same PR whichever project you are
 *                                         viewing (see ORG_CACHE_DIR)
 *   the request concurrency semaphore     ado/client.js, module-level on
 *                                         purpose. ADO throttles per token
 *                                         identity; with several projects (and
 *                                         possibly several PATs) resident, one
 *                                         shared budget over-throttles rather
 *                                         than under-throttles, which is the
 *                                         safe direction.
 *
 * Not used by this app at all, so nothing to scope: builds, releases,
 * branches, repositories-as-a-view, test plans.
 *
 * SPANNING the scopes, rather than being scoped by them:
 *
 *   cross-project hours                   server/crossHours.js. Walks this
 *                                         registry, opening one scope per
 *                                         project and reading each project's
 *                                         own revision index through it — so
 *                                         it adds nothing to what any scope
 *                                         knows and can see nothing a scope
 *                                         couldn't — including when the hours
 *                                         asked about are a TEAMMATE's (the
 *                                         Team page card): the person is only
 *                                         a changedBy filter, while the scopes
 *                                         are still opened with the CALLER's
 *                                         credentials. Its RESULT is per
 *                                         viewer+person, not per project, so
 *                                         it is cached in ORG_CACHE_DIR beside
 *                                         the scopes, and every row it returns
 *                                         names the project it came from.
 *
 * BELOW every scope, rather than beside them:
 *
 *   demo mode                             server/demo/transport.js. Replaces the
 *                                         network under every AdoClient, process-
 *                                         wide, with a fictional organization that
 *                                         is org-scoped exactly like the real one
 *                                         (WIQL ignores the URL's project; batch
 *                                         reads return any project's items). So
 *                                         every clause and re-check above runs
 *                                         unchanged against it, and a missing one
 *                                         leaks there just as it would here.
 */

/** Scopes with no open SSE stream / in-flight sync are dropped after this. */
const IDLE_EVICT_MS = 30 * 60 * 1000;

/** Cache keys that were written before the app was multi-project, back when
 * .cache/ held exactly one project's data. Moved into the default project's
 * scope directory the first time it's opened — mainly for revisionIndex,
 * which costs ~90 paged requests to rebuild from scratch. */
const LEGACY_CACHE_KEYS = [
  'discovery',
  'iterationMap',
  'people',
  'states',
  'revisionIndex',
  'workItemUpdates',
];
/** Org-wide even in the single-project era: moved beside the scopes, not into
 * one of them. See ORG_CACHE_DIR. */
const LEGACY_ORG_CACHE_KEYS = ['pr-candidates-v1'];
/** Dead on arrival — the live keys are `dashboard-v6-`/`pr-index-v2-` now,
 * bumped because a v4/v1 payload was built from both the org-wide PR search and
 * the unscoped WIQL queries. Still moved out of the root so a machine upgrading
 * from the single-project era doesn't leave litter at the top of .cache/. */
const LEGACY_CACHE_PREFIXES = ['dashboard-v4-', 'pr-index-v1-'];

/** PR attribution candidates are keyed by PR id and describe the pull request,
 * not the viewer — and pull requests are ORG-scoped in this app on purpose (see
 * server/ado/pullrequests.js). So that one cache lives beside the scopes rather
 * than inside each of them, instead of every project re-paying 2 ADO requests
 * per PR to rebuild the same answer. */
const ORG_CACHE_DIR = '_org';

/** A human-recognizable, filesystem-safe directory name. The id suffix keeps
 * two projects whose names differ only in punctuation apart, and makes the
 * directory stable across a project rename. */
function scopeSlug(project) {
  const base = String(project.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const id = project.id || crypto.createHash('sha1').update(String(project.name)).digest('hex');
  return `${base || 'project'}-${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 8)}`;
}

function scopeKey(project) {
  // The GUID when we have it: it survives renames, so a renamed project keeps
  // its warm scope instead of silently starting cold under a new key.
  return project.id ? `id:${project.id}` : `name:${String(project.name).toLowerCase()}`;
}

/**
 * Which token this project's shared and background reads run under.
 *
 * ADO_PAT is preferred: it's the deployment's own token, it doesn't disappear
 * when a person signs out, and background polling under it is attributed to
 * the deployment rather than to whoever happened to open the project. But it
 * is optional now, and it may simply not have access to a project some
 * teammate can read — in that case the opener's own PAT is used, and the scope
 * is marked so nothing background-facing runs on it (see startPolling and
 * isOwner in server/sync.js).
 *
 * The PAT is never written to disk here or anywhere else: it lives only in the
 * caller's sealed cookie and in AdoClient's in-memory auth header.
 */
async function electReadToken(project, { pat, identity }, baseConfig) {
  if (baseConfig.pat) {
    const probe = new AdoClient({ ...baseConfig, project: project.name, pat: baseConfig.pat });
    try {
      await probe.get('/wit/workitemtypes');
      return { kind: 'service', pat: baseConfig.pat };
    } catch (err) {
      // Not readable by the service token — fall through to the caller's own.
    }
  }
  return {
    kind: 'user',
    pat,
    ownerId: identity && identity.id,
    ownerUniqueName: identity && identity.uniqueName,
  };
}

  /**
 * The per-project config one scope's AdoClient, SyncEngine, Cache and OrgStore
 * all read from — the single place a project's identity turns into concrete
 * paths and names. Pure, and exported, so the isolation properties it is
 * responsible for can be asserted directly:
 *
 *  - `cacheDir` differs per project, which is what makes every cache key
 *    (dashboards, PR index, PR attribution candidates, revision index, states,
 *    types) project-scoped without any key carrying a project prefix.
 *  - `rolesWikiName` is derived from the project name, which is what makes
 *    TEAMS per-project: the org chart's storage location IS its scoping, so
 *    server/org.js needs no projectId field.
 *  - `orgDataFile` is the matching per-project local fallback.
 */
function buildScopeConfig(baseConfig, project, { readTokenIsService, cacheDir } = {}) {
  const dir = cacheDir || path.join(baseConfig.cacheDir, scopeSlug(project));
  return {
    ...baseConfig,
    project: project.name,
    projectId: project.id || null,
    cacheDir: dir,
    // Each project's chart lives on ITS OWN wiki, which is what makes teams
    // per-project without any change to the org chart's shape (server/org.js).
    rolesWikiName: `${project.name}.wiki`,
    orgDataFile: path.join(baseConfig.orgDataDir, `${scopeSlug(project)}.json`),
    // Read by SyncEngine.isOwner — see the comment there for why the
    // "no ADO_OWNER_EMAIL" fallback must not apply to a user-PAT scope.
    readTokenIsService: !!readTokenIsService,
  };
}

function createScopeRegistry(baseConfig) {
  /** @type {Map<string, object>} scopeKey -> scope */
  const scopes = new Map();
  const orgCache = new Cache(path.join(baseConfig.cacheDir, ORG_CACHE_DIR));
  /** scopeKey -> Promise<scope>, so two concurrent first requests for the same
   * project don't each build an engine (and each pay the read-token probe). */
  const building = new Map();
  let pollTimer = null;

  /** Best-effort one-time move of the pre-multi-project .cache/*.json into the
   * default project's scope directory. Every step is swallowed: a failure just
   * means that project syncs cold once. */
  function migrateLegacyCache(project, cacheDir) {
    if (!baseConfig.defaultProject || project.name !== baseConfig.defaultProject) return;
    let entries;
    try {
      // The scope's Cache isn't constructed yet, so its directory has to exist
      // before anything can be renamed into it.
      fs.mkdirSync(cacheDir, { recursive: true });
      entries = fs.readdirSync(baseConfig.cacheDir);
    } catch {
      return;
    }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const key = file.slice(0, -'.json'.length);
      const isOrgWide = LEGACY_ORG_CACHE_KEYS.includes(key);
      const isLegacy =
        isOrgWide || LEGACY_CACHE_KEYS.includes(key) || LEGACY_CACHE_PREFIXES.some((p) => key.startsWith(p));
      if (!isLegacy) continue;
      const target = isOrgWide ? path.join(baseConfig.cacheDir, ORG_CACHE_DIR, file) : path.join(cacheDir, file);
      try {
        if (fs.existsSync(target)) continue;
        fs.renameSync(path.join(baseConfig.cacheDir, file), target);
      } catch {
        // leave it where it is — worst case the project rebuilds that entry
      }
    }
  }

  /** The single-project era kept one org chart cache at data/org.json. Seed
   * the default project's per-project file from it so an offline start still
   * has a fallback chart. The wiki remains the durable copy either way. */
  function migrateLegacyOrgFile(project, orgDataFile) {
    if (!baseConfig.defaultProject || project.name !== baseConfig.defaultProject) return;
    const legacy = path.join(baseConfig.dataDir, 'org.json');
    try {
      if (fs.existsSync(orgDataFile) || !fs.existsSync(legacy)) return;
      fs.mkdirSync(path.dirname(orgDataFile), { recursive: true });
      fs.copyFileSync(legacy, orgDataFile);
    } catch {
      // best-effort; the wiki is the durable copy
    }
  }

  async function build(project, credentials) {
    const readToken = await electReadToken(project, credentials, baseConfig);
    const cacheDir = path.join(baseConfig.cacheDir, scopeSlug(project));
    const config = buildScopeConfig(baseConfig, project, {
      readTokenIsService: readToken.kind === 'service',
      cacheDir,
    });
    migrateLegacyCache(project, cacheDir);
    migrateLegacyOrgFile(project, config.orgDataFile);

    const cache = new Cache(cacheDir);
    const sync = new SyncEngine({ ...config, pat: readToken.pat }, cache, orgCache);
    const scrum = new ScrumEngine(config, cache, sync);
    const scope = {
      key: scopeKey(project),
      project: { id: project.id || null, name: project.name },
      config,
      cache,
      sync,
      scrum,
      readToken,
      refs: 0,
      lastUsedAt: Date.now(),
      createdAt: Date.now(),
    };
    // Matches the startup sync the single-project server used to do — but only
    // under the service token, never under a person's PAT.
    if (readToken.kind === 'service') {
      sync.pollOnce();
    }
    return scope;
  }

  /** LRU: drop the least recently used resident scope over the cap, plus any
   * scope idle long enough not to be worth its memory. Never touches a scope
   * with an open SSE stream or work in flight. */
  function evictIdle() {
    const now = Date.now();
    const evictable = (scope) =>
      scope.refs === 0 && scope.sync.inFlight.size === 0 && scope.sync.prFillInFlight.size === 0;

    for (const [key, scope] of scopes) {
      const idle = now - scope.lastUsedAt > IDLE_EVICT_MS;
      if (idle && evictable(scope)) {
        scope.sync.dispose();
        scopes.delete(key);
      }
    }

    if (scopes.size <= baseConfig.maxProjectScopes) return;
    const byAge = [...scopes.entries()].filter(([, s]) => evictable(s)).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, scope] of byAge) {
      if (scopes.size <= baseConfig.maxProjectScopes) break;
      scope.sync.dispose();
      scopes.delete(key);
    }
  }

  return {
    orgCache,

    /**
     * The scope for `project` ({id, name} straight from the sealed session),
     * building it on first use. `credentials` is the CALLER's — used to elect
     * a read token when the service PAT can't read this project, and to
     * re-elect one if the scope's user PAT has since died.
     */
    async getScope(project, credentials) {
      const key = scopeKey(project);
      const existing = scopes.get(key);
      if (existing) {
        existing.lastUsedAt = Date.now();
        // A scope running on a token that has died heals as soon as any
        // caller with a working token asks for it. Deliberately NOT gated on
        // `readToken.kind === 'user'` any more: a dead SERVICE ADO_PAT must
        // heal the same way, by re-running electReadToken (which retries the
        // service token first, same as at scope build time) rather than
        // being stuck until process restart — electReadToken only ever
        // falls back to `credentials.pat` (never persists it, never uses it
        // for background polling), so this doesn't change what a "user" read
        // token means, only when re-election is attempted.
        if (existing.sync.readTokenInvalid && credentials.pat) {
          const readToken = await electReadToken(project, credentials, baseConfig);
          existing.readToken = readToken;
          existing.config.readTokenIsService = readToken.kind === 'service';
          existing.sync.config.readTokenIsService = readToken.kind === 'service';
          existing.sync.setClient(new AdoClient({ ...existing.config, pat: readToken.pat }));
        }
        return existing;
      }

      const inProgress = building.get(key);
      if (inProgress) return inProgress;

      const promise = build(project, credentials)
        .then((scope) => {
          scopes.set(key, scope);
          evictIdle();
          return scope;
        })
        .finally(() => building.delete(key));
      building.set(key, promise);
      return promise;
    },

    /** The resident scope, if any — no network, no building. Used by
     * GET /api/auth/me, which the client polls on every window focus and
     * which must never fire an ADO call as a side effect. */
    peek(project) {
      return project ? scopes.get(scopeKey(project)) : undefined;
    },

    list() {
      return [...scopes.values()];
    },

    /** Marks one more consumer (an open SSE stream) as depending on a scope,
     * so eviction can't pull the engine out from under it. */
    retain(scope) {
      scope.refs += 1;
      return () => {
        scope.refs = Math.max(0, scope.refs - 1);
        scope.lastUsedAt = Date.now();
      };
    },

    /**
     * Background polling for every resident project, one at a time.
     *
     * Sequential on purpose: ADO's rate budget is per token identity, and the
     * service PAT is one identity no matter how many projects are open — N
     * parallel cold syncs would queue N revision-index rebuilds against it.
     * Projects nobody has touched in a while are skipped (they'll sync on
     * open), and user-PAT scopes are never polled at all.
     */
    startPolling(intervalMs) {
      const run = async () => {
        for (const scope of [...scopes.values()]) {
          if (scope.readToken.kind !== 'service') continue;
          if (Date.now() - scope.lastUsedAt > 2 * intervalMs) continue;
          await scope.sync.pollOnce();
        }
        evictIdle();
      };
      pollTimer = setInterval(() => {
        run().catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[scopes] poll cycle failed:', err.message);
        });
      }, intervalMs);
      pollTimer.unref();
    },

    /** Drops every resident scope (demo reset): the next request for a
     * project builds a fresh one from scratch. */
    clearAll() {
      for (const scope of scopes.values()) scope.sync.dispose();
      scopes.clear();
    },

    stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
    },

    evictIdle,
  };
}

module.exports = { createScopeRegistry, electReadToken, scopeSlug, scopeKey, buildScopeConfig };
