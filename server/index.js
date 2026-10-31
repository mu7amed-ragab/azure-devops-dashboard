const fs = require('fs');
const fastifyStatic = require('@fastify/static');
const fastifyCookie = require('@fastify/cookie');
const fastify = require('fastify');
const { loadConfig } = require('./config');
const { createScopeRegistry } = require('./scopes');
const { CrossHours } = require('./crossHours');
const { AdoClient, getRealRequestCount } = require('./ado/client');
const { getIdentity } = require('./ado/discovery');
const { listProjects } = require('./ado/projects');
const { deriveKey, seal, unseal, checkPassword, RateLimiter } = require('./auth');
const { ValidationError, ForbiddenError, computeLogHours, computeSetProgress, fetchCurrentTaskHours } = require('./ado/writeback');
const { attributePullRequests } = require('./ado/prAttribution');
const { buildRepoPrGroups, prStatusId, prCheapMatch } = require('./compute/prGroups');
const { canSeeTeamPage, canSeePullRequests, canAdminOrg, assignableRoles, canAssignRole, findMember, findMemberByEmail, findTeam } = require('./org');
const { DEFAULT_SPRINT_WINDOW } = require('./scrumConstants');
const { fetchEligibleBlockedFields, detectBlockedSignal } = require('./ado/discovery');
const { validateConvention } = require('./blockedConvention');
const { errorBody } = require('./errorBody');

// Caps the one-off attribution pass a PR-number search falls back to (see
// GET /api/pullrequests) — bounded to the most recent PRs in ONE repo, so a
// search can never re-attribute a whole repo's history and reintroduce the
// per-PR HTTP cost this endpoint exists to avoid.
const SEARCH_ATTRIBUTION_CAP = 100;

/** Sort key for a cheap-matched PR search result — an exact or prefix id
 * match leads a substring id match, which leads a title-only match, so a
 * search for "12" surfaces PR #12 before every PR whose title merely
 * contains "12". Lower sorts first. */
function rankPrMatch(pr, q) {
  const id = String(pr.id);
  if (id === q) return 0;
  if (id.startsWith(q)) return 1;
  if (id.includes(q)) return 2;
  return 3;
}

// The real app's cookie names. Demo mode uses different ones (config.cookieNames),
// since browsers share cookies across ports on the same host.
const DEFAULT_COOKIES = { gate: 'azdash_gate', session: 'azdash_session' };
const GATE_TTL_MS = 15 * 60 * 1000;

function statusForError(err) {
  if (err instanceof ForbiddenError) return 403;
  if (err && err.code === 'CONFLICT') return 409; // e.g. OrgStore's wiki ETag guard
  if (err && err.code === 'WIKI_MISSING') return 422; // matches contracts/scrum-api.md's blocked-convention write
  if (err instanceof ValidationError) return 400;
  if (err.status === 409) return 409;
  if (err.status === 401 || err.status === 403) return 403;
  return 502;
}

/** True only for a bare Azure DevOps 401 — ForbiddenError (the app's own
 * "not your item" check) and ValidationError already carry their own
 * status and must never be mistaken for an expired token. A 403 from ADO
 * itself is deliberately NOT included here: it's ambiguous (could mean
 * "this token lacks one scope" as easily as "wrong item"), so treating it
 * as PAT expiry would sign out people over a false positive. Only ADO's
 * own 401 is the unambiguous "this token is dead" signal. */
function isPatExpired(err) {
  return !(err instanceof ForbiddenError) && !(err instanceof ValidationError) && err.status === 401;
}

/** Shared error handler for every write route (log hours, state, iteration
 * moves): these run under the caller's OWN PAT (req.session.client), so
 * unlike shared reads, a 401 here means THIS person's token specifically
 * expired or was revoked. Clears their session so the client's existing
 * redirect-to-login-on-401 path (see web/src/lib/api.ts) fires with a clear
 * reason, instead of leaving them stuck on a dashboard that mysteriously
 * fails every write. */
function handleWriteError(err, reply, sessionCookie = DEFAULT_COOKIES.session) {
  if (isPatExpired(err)) {
    reply.clearCookie(sessionCookie, { path: '/' });
    reply.code(401);
    return { error: "Your access token has expired or was revoked — sign in again with a new one.", code: 'PAT_EXPIRED' };
  }
  reply.code(statusForError(err));
  return errorBody(err, err.code || (err.status === 409 ? 'CONFLICT' : 'ADO_ERROR'));
}

/** Same PAT_EXPIRED contract as handleWriteError, for the read routes that
 * sync a dashboard/PR index instead of writing one (GET /api/dashboard,
 * /api/pullrequests, /api/pullrequests/repos). Those routes previously
 * swallowed a syncPerson() rejection into a console.error and kept
 * answering 202 "syncing" or a permanently-stale cache forever — this is
 * what turns THAT specific failure into the same clear sign-out the write
 * path already gives, without touching the unrelated failure modes (a
 * teammate's sync failing, a transient/non-401 error) those routes already
 * handle correctly.
 *
 * Only fires for the CALLER'S OWN identity (`person.isSelf`) AND only when
 * the sync that failed actually ran under THIS PERSON'S OWN PAT — i.e. the
 * scope's elected read token is `kind: 'user'` and its `ownerId` is this
 * person's id. A project's read token is frequently the shared service
 * `ADO_PAT`, or the PAT of whichever teammate happened to open the project
 * first (see server/scopes.js electReadToken) — in both of those cases a
 * dead token is NOT this caller's own token, so telling them "your access
 * token has expired" would be wrong and would sign out every innocent user
 * of a shared/dead token. That case falls through to the existing
 * readTokenInvalid/serviceTokenInvalid banner instead (surfaced via
 * `/api/auth/me`).
 *
 * Returns the response body to send with reply.code(401) already set, or
 * null if this isn't that case — callers fall through to their existing
 * behavior. */
function handleSelfSyncError(err, person, readToken, reply, sessionCookie = DEFAULT_COOKIES.session) {
  if (!err || !person.isSelf || !isPatExpired(err)) return null;
  if (!readToken || readToken.kind !== 'user' || readToken.ownerId !== person.id) return null;
  reply.clearCookie(sessionCookie, { path: '/' });
  reply.code(401);
  return { error: "Your access token has expired or was revoked — sign in again with a new one.", code: 'PAT_EXPIRED' };
}

/** `secure` is decided by the actual connection, not by NODE_ENV: a browser
 * silently DROPS a Secure cookie served over plain http, which would make
 * signing in impossible — and now that every deployment has a login, that
 * includes the two production-mode deployments that legitimately speak http
 * (the IIS/loopback setup in deploy/, and local `npm start`). With
 * trustProxy on, req.protocol already honors X-Forwarded-Proto, so a real
 * HTTPS deployment behind a proxy still gets Secure. */
function cookieOpts(maxAgeMs, req) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

/**
 * Builds and registers every route on a fresh Fastify instance without
 * starting a listener or the background poll timer — the seam that lets
 * tests exercise the real HTTP-level auth gates (onRequest, requireTeamPage,
 * requireProjectAdmin) via `app.inject()` against a fake scope, rather than
 * duplicating that logic. `main()` below is the only production caller;
 * `registry` and `crossHours` are unchanged from what it already built —
 * see server/scopes.js and server/crossHours.js for what each owns. One
 * scope (AdoClient + SyncEngine + disk cache + org chart) per Azure DevOps
 * project, built lazily for whichever project each person picked at sign-in
 * — there is deliberately no process-wide "current project" any more.
 */
async function buildApp({ config, registry, crossHours }) {
  const app = fastify({
    logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' },
    trustProxy: true, // behind Render's proxy in production; needed for accurate req.ip in the login rate limiter
  });

  app.register(fastifyCookie);

  const cookieNames = config.cookieNames || DEFAULT_COOKIES;
  const SESSION_COOKIE = cookieNames.session;
  const GATE_COOKIE = cookieNames.gate;
  // Present only in demo mode, so a real /api/auth/me response is unchanged.
  const withDemoFlag = (body) => (config.demo ? { ...body, demo: true } : body);

  // ---------------------------------------------------------------------
  // Auth, in three steps: a shared APP_PASSWORD gates a form where each
  // person enters their own ADO PAT, and then picks one of the projects that
  // token can actually read. That project is part of their session and is what
  // every route below is served out of. The same flow runs locally as on a
  // hosted deployment — there is no second, PAT-is-the-identity mode.
  //
  // No session store: the session is the encrypted cookie itself (AES-256-GCM,
  // see server/auth.js), holding the person's own PAT and their chosen
  // project. That PAT is used for every write so changes land in Azure DevOps
  // under the actual person who made them; shared/project-wide reads go
  // through the scope's read token (the service ADO_PAT where it has access,
  // otherwise the opener's own — see server/scopes.js electReadToken).
  const sessionKey = deriveKey(config.sessionSecret);
  const sessionTtlMs = config.sessionTtlHours * 60 * 60 * 1000;
  // The demo password is public and the capture tool signs in on every run, so
  // demo mode does not ration attempts the way a real deployment must.
  const passwordLimiter = new RateLimiter({ max: config.demo ? 1000 : 5, windowMs: 15 * 60 * 1000 });
  const fullSyncLimiter = new RateLimiter({ max: 1, windowMs: 60 * 1000 });
  // The Team page and the account menu ask for a fresh roles read on every
  // mount (?refresh=1) — cheap now that roles come from the in-memory org
  // store rather than a wiki fetch, but still rate-limited to keep
  // route-flipping from calling ensureRoles(true) on every mount.
  const rolesRefreshLimiter = new RateLimiter({ max: 1, windowMs: 30 * 1000 });
  // GET /api/pullrequests triggers real ADO attribution calls (up to 2 per
  // PR in the requested page, or up to SEARCH_ATTRIBUTION_CAP on a search
  // fallback) — capped per person so rapid "Load more" clicking or a tight
  // client retry loop can't hammer ADO.
  const prPageLimiter = new RateLimiter({ max: 30, windowMs: 60 * 1000 });
  // The project list is one ADO call under the caller's own token; re-fetched
  // whenever the project step (re)mounts, so it needs a ceiling but a
  // generous one.
  const projectListLimiter = new RateLimiter({ max: config.demo ? 1000 : 10, windowMs: 5 * 60 * 1000 });
  // GET /api/hours/cross is polled every couple of seconds while a build
  // runs (a cold one walks every project's revision feed), so the ceiling has
  // to allow sustained polling while still bounding a client stuck in a tight
  // retry loop. The expensive work behind it is deduped per person anyway —
  // see CrossHours._start.
  //
  // Sized for the Team page rather than the Dashboard: one card per open
  // member section can be polling at once (2s each), so a lead with several
  // members expanded legitimately makes many more requests per minute than
  // the single Dashboard card ever did.
  const crossHoursLimiter = new RateLimiter({ max: 240, windowMs: 60 * 1000 });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/auth/me', async (req) => {
    const session = unseal(req.cookies[SESSION_COOKIE], sessionKey);
    if (session && Date.now() - session.iat < sessionTtlMs) {
      const self = { id: session.id, displayName: session.displayName, uniqueName: session.uniqueName };
      if (!session.project) {
        // Signed in but hasn't picked a project yet — either a fresh sign-in
        // or a session whose project became unreadable (see the onRequest
        // hook, which clears the field rather than the whole session so
        // nobody has to re-enter a password and a PAT to recover).
        return withDemoFlag({ authEnabled: true, stage: 'project', org: config.org, self, defaultProject: config.defaultProject });
      }
      return withDemoFlag({
        authEnabled: true,
        stage: 'ready',
        self,
        project: session.project,
        // Shared reads (sprints, roster, revision index) all go through this
        // project's read token — if it's expired/revoked, everyone looking at
        // this project is affected at once, so it rides along on every
        // /api/auth/me poll rather than needing its own endpoint. `peek`
        // deliberately never builds a scope: this route is polled on every
        // window focus and must not fire ADO calls as a side effect.
        serviceTokenInvalid: Boolean(registry.peek(session.project) && registry.peek(session.project).sync.readTokenInvalid),
      });
    }
    const gate = unseal(req.cookies[GATE_COOKIE], sessionKey);
    if (gate && Date.now() - gate.iat < GATE_TTL_MS) {
      // The org isn't secret (it's already in every ADO URL this app links
      // to) — sent here so the PAT step can link straight to the right
      // token-creation page.
      return withDemoFlag({ authEnabled: true, stage: 'pat', org: config.org });
    }
    return withDemoFlag({ authEnabled: true, stage: 'password' });
  });

  app.post('/api/auth/password', async (req, reply) => {
    if (!passwordLimiter.consume(req.ip)) {
      reply.code(429);
      return { error: 'Too many attempts — try again in a few minutes.', code: 'RATE_LIMITED' };
    }
    const password = req.body && req.body.password;
    if (!checkPassword(password, config.appPassword)) {
      reply.code(401);
      return { error: 'Incorrect password.', code: 'VALIDATION' };
    }
    reply.setCookie(GATE_COOKIE, seal({ iat: Date.now() }, sessionKey), cookieOpts(GATE_TTL_MS, req));
    return { ok: true };
  });

  // Verifies the PAT belongs to a real identity in this organization and
  // returns the projects it can see, which is what the next step picks from.
  // Never trusts the ADO_PAT-based service client for this: a candidate PAT
  // from the wrong organization must fail here, not silently inherit access
  // it doesn't actually have.
  app.post('/api/auth/pat', async (req, reply) => {
    const gate = unseal(req.cookies[GATE_COOKIE], sessionKey);
    if (!gate || Date.now() - gate.iat > GATE_TTL_MS) {
      reply.code(401);
      return { error: 'Your session expired — enter the password again.', code: 'GATE_EXPIRED' };
    }

    const pat = req.body && typeof req.body.pat === 'string' ? req.body.pat.trim() : '';
    if (!pat) {
      reply.code(400);
      return { error: 'A personal access token is required.', code: 'VALIDATION' };
    }

    const candidateClient = new AdoClient({ ...config, pat });

    let identity;
    try {
      // getIdentity, not discover(): discover also probes for this process
      // template's "Blocked" signal, which is project-scoped — and at this
      // step no project has been chosen yet.
      identity = await getIdentity(candidateClient);
    } catch (err) {
      reply.code(401);
      return { error: 'Azure DevOps rejected this token — check that it is valid and hasn\'t expired.', code: 'INVALID_PAT' };
    }
    if (!identity || !identity.id || !identity.uniqueName) {
      reply.code(401);
      return { error: 'This token could not be resolved to a user identity.', code: 'INVALID_PAT' };
    }

    let projects;
    try {
      projects = await listProjects(candidateClient);
    } catch (err) {
      reply.code(403);
      return {
        error:
          `This token could not list the projects in the "${config.org}" organization. ` +
          'Make sure it was created in the same organization and has the Project and Team (Read) scope.',
        code: 'PAT_NO_PROJECTS',
      };
    }
    if (projects.length === 0) {
      reply.code(403);
      return {
        error: `This token can't see any projects in the "${config.org}" organization.`,
        code: 'PAT_NO_PROJECTS',
      };
    }

    const session = {
      v: 2,
      pat,
      id: identity.id,
      displayName: identity.displayName,
      uniqueName: identity.uniqueName,
      // Chosen on the next step. Until then the session is authenticated but
      // not yet usable for anything else — see the onRequest hook.
      project: null,
      iat: Date.now(),
    };
    reply.setCookie(SESSION_COOKIE, seal(session, sessionKey), cookieOpts(sessionTtlMs, req));
    reply.clearCookie(GATE_COOKIE, { path: '/' });
    return { ok: true, self: { id: identity.id, displayName: identity.displayName, uniqueName: identity.uniqueName }, projects };
  });

  /** The signed-in session, whether or not a project has been picked yet —
   * the two project routes below are the only ones that accept that state. */
  function projectStepSession(req, reply) {
    const session = unseal(req.cookies[SESSION_COOKIE], sessionKey);
    if (!session || Date.now() - session.iat > sessionTtlMs) {
      reply.code(401);
      return null;
    }
    return session;
  }

  // Re-fetched by the project step whenever it mounts without a list in hand
  // (e.g. the page was reloaded after the PAT was accepted), so nobody has to
  // paste their token again just to see the choices.
  app.get('/api/auth/projects', async (req, reply) => {
    const session = projectStepSession(req, reply);
    if (!session) return { error: 'Sign in required.', code: 'UNAUTHENTICATED' };
    if (!projectListLimiter.consume(session.id)) {
      reply.code(429);
      return { error: 'Too many requests — try again in a moment.', code: 'RATE_LIMITED' };
    }
    try {
      const projects = await listProjects(new AdoClient({ ...config, pat: session.pat }));
      return { projects, defaultProject: config.defaultProject };
    } catch (err) {
      reply.code(statusForError(err));
      return { error: 'Could not list your projects — your token may have expired.', code: 'PAT_NO_PROJECTS' };
    }
  });

  // The last step of sign-in: bind a project to the session. Everything the
  // dashboard then shows comes from this project's scope.
  app.post('/api/auth/project', async (req, reply) => {
    const session = projectStepSession(req, reply);
    if (!session) return { error: 'Sign in required.', code: 'UNAUTHENTICATED' };

    const requested = req.body && typeof req.body.project === 'string' ? req.body.project.trim() : '';
    if (!requested) {
      reply.code(400);
      return { error: 'A project is required.', code: 'VALIDATION' };
    }

    const sessionClient = new AdoClient({ ...config, pat: session.pat });
    let projects;
    try {
      projects = await listProjects(sessionClient);
    } catch (err) {
      reply.code(statusForError(err));
      return { error: 'Could not list your projects — your token may have expired.', code: 'PAT_NO_PROJECTS' };
    }
    // Matched against the real list rather than trusted: this is what
    // canonicalizes the name, supplies the id the scope is keyed by, and
    // guarantees no request value ever reaches a filesystem path.
    const match = projects.find((p) => p.name.toLowerCase() === requested.toLowerCase());
    if (!match) {
      reply.code(400);
      return { error: `“${requested}” isn't a project this token can see.`, code: 'UNKNOWN_PROJECT' };
    }

    try {
      // Cheap, project-scoped call: being listed above only needs Project and
      // Team (Read), while the dashboard needs to read work items.
      await new AdoClient({ ...config, project: match.name, pat: session.pat }).get('/wit/workitemtypes');
    } catch (err) {
      reply.code(403);
      return {
        error:
          `This token can't read work items in “${match.name}”. Make sure it has Work Items (Read & Write), ` +
          'Code (Read), Project and Team (Read), and Wiki (Read) scopes.',
        code: 'PROJECT_NO_ACCESS',
      };
    }

    const project = { id: match.id, name: match.name };
    // iat is preserved deliberately: picking a project is not a new sign-in,
    // so it must not silently extend the session's lifetime.
    reply.setCookie(SESSION_COOKIE, seal({ ...session, project }, sessionKey), cookieOpts(sessionTtlMs, req));
    // Warms the scope (and elects its read token) here rather than on the
    // first dashboard request's critical path.
    await registry.getScope(project, {
      pat: session.pat,
      identity: { id: session.id, displayName: session.displayName, uniqueName: session.uniqueName },
    });
    return { ok: true, project };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(GATE_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Every other /api/* route needs a resolved session: `identity` (who this
  // request is acting as), `client` (an AdoClient authenticated as that
  // person, used for writes), and `scope` — the project they picked at
  // sign-in, which owns the SyncEngine, cache and org chart everything below
  // reads from.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url || '';
    if (!url.startsWith('/api')) return;
    if (url.startsWith('/api/auth/') || url.startsWith('/api/health')) return;
    if (config.demo && url.startsWith('/api/demo/status')) return;

    const session = unseal(req.cookies[SESSION_COOKIE], sessionKey);
    if (!session || Date.now() - session.iat > sessionTtlMs) {
      reply.code(401).send({ error: 'Sign in required.', code: 'UNAUTHENTICATED' });
      return;
    }
    if (!session.project) {
      reply.code(401).send({ error: 'Pick a project to continue.', code: 'PROJECT_REQUIRED' });
      return;
    }

    const identity = { id: session.id, displayName: session.displayName, uniqueName: session.uniqueName };
    let scope;
    try {
      scope = await registry.getScope(session.project, { pat: session.pat, identity });
    } catch (err) {
      // The project was deleted, renamed, or this token's access to it was
      // revoked. Only the project field is cleared, not the whole session, so
      // the bounce to /login lands straight on the project step instead of
      // asking for the password and the PAT again.
      reply.setCookie(SESSION_COOKIE, seal({ ...session, project: null }, sessionKey), cookieOpts(sessionTtlMs, req));
      reply.code(401).send({
        error: `“${session.project.name}” is no longer available to you — pick another project.`,
        code: 'PROJECT_UNAVAILABLE',
      });
      return;
    }

    req.session = {
      identity,
      // Writes run under the caller's own PAT, against the scope's project.
      client: new AdoClient({ ...scope.config, pat: session.pat }),
      // The raw PAT, for the one route that has to reach OUTSIDE this scope:
      // cross-project hours needs to list the caller's projects and open a
      // scope per project, which is exactly what `client` above (bound to one
      // project) cannot do. In-process only — it goes no further than the
      // sealed cookie it came from.
      pat: session.pat,
      scope,
    };
  });

  app.get('/api/people', async (req, reply) => {
    const { sync } = req.session.scope;
    try {
      const refresh = req.query.refresh === '1' && rolesRefreshLimiter.consume(`${req.session.scope.key}:${req.session.identity.id}`);
      const [people, role, identities] = await Promise.all([
        sync.ensurePeople(),
        sync.getRoleFor(req.session.identity.uniqueName, refresh),
        // 006-linked-identity-aliases (FR-009, T025): lazily resolved and
        // 24h-cached (see SyncEngine.ensureIdentitySet) — never awaited by
        // sign-in itself (FR-012), only by this poll-on-focus endpoint,
        // which already tolerates a slower-than-usual response the same
        // way it already does for `role`/`people` above.
        sync.ensureIdentitySet(req.session.identity).catch(() => null),
      ]);
      const self = req.session.identity;
      const isOwner = await sync.isOwner(self.uniqueName);
      return {
        self: {
          id: self.id,
          displayName: self.displayName,
          uniqueName: self.uniqueName,
          role,
          isOwner,
          canSeePullRequests: canSeePullRequests(role),
          canSeeTeamPage: canSeeTeamPage(role, isOwner),
          canAdminOrg: canAdminOrg(role, isOwner),
          // Always an array — [] for the common single-identity case, so a
          // client that hasn't been updated to know about linking sees
          // nothing new. See contracts/api.md.
          linkedIdentities: (identities && identities.linked) || [],
          identitiesDegraded: !!(identities && identities.degraded),
        },
        people,
      };
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  // Destructive and project-wide, so restricted to the configured owner (see
  // sync.isOwner) rather than any logged-in person. Scoped to the caller's own
  // project: it empties that scope's cache directory only, never another
  // project's and never the shared org-wide PR attribution cache.
  if (config.demo) {
    // Demo mode only: what the in-process demo organization has seen. Carries
    // no work data, so it needs no session — the capture tool and the
    // quickstart read it to prove no real network request was made.
    app.get('/api/demo/status', async () => {
      const demo = require('./demo');
      const state = demo.getState();
      return {
        demo: true,
        seededAt: demo.seededAt,
        realNetworkRequests: getRealRequestCount(),
        unhandled: [...state.unhandled],
        handlerErrors: state.handlerErrors.slice(),
      };
    });

    // Puts the demo organization back to its seeded state: every write made
    // in this demo session, and every cache built from it, is discarded.
    app.post('/api/demo/reset', async (req, reply) => {
      const { sync } = req.session.scope;
      if (!(await sync.isOwner(req.session.identity.uniqueName))) {
        reply.code(403);
        return { error: 'Only the dashboard owner can reset the demo.', code: 'FORBIDDEN' };
      }
      const demo = require('./demo');
      demo.reseed({ seed: config.demoSeed });
      registry.clearAll();
      for (const dir of [config.cacheDir, config.orgDataDir]) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
      }
      return { ok: true, seededAt: demo.seededAt };
    });
  }

  app.post('/api/cache/clear', async (req, reply) => {
    const { sync } = req.session.scope;
    if (!(await sync.isOwner(req.session.identity.uniqueName))) {
      reply.code(403);
      return { error: 'Only the dashboard owner can clear the cache.', code: 'FORBIDDEN' };
    }
    sync.clearCache();
    return { ok: true };
  });

  app.get('/api/people/search', async (req, reply) => {
    const { sync } = req.session.scope;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return { people: [] };
    try {
      const people = await sync.searchPeople(q);
      return { people };
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  // Search reaches PAST ownership (005-search-history-sprint-placement,
  // US1) — read-only, project-scoped via req.session.scope like every other
  // route. `q` under 2 chars short-circuits with no ADO call, mirroring
  // /api/people/search above. `?person=` is gated on requireTeamPage (defined
  // below) the same way /api/dashboard etc. gate it — declared after this
  // route in source order, but hoisted as a function declaration so it's
  // callable here.
  app.get('/api/workitems/search', async (req, reply) => {
    const { sync } = req.session.scope;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) return { results: [], truncated: false, query: '' };

    if (req.query.person) {
      const { allowed } = await requireTeamPage(req, reply);
      if (!allowed) {
        return { error: 'The Team page is only available to leads, principals, and scrum accounts.', code: 'FORBIDDEN' };
      }
    }

    const person = await sync.resolvePerson(req.session.identity, req.query.person);
    if (!person) {
      reply.code(404);
      return { error: 'Unknown person.', code: 'VALIDATION' };
    }

    try {
      return await sync.searchEverAssigned(person, q);
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  app.get('/api/states', async (req, reply) => {
    const { sync } = req.session.scope;
    try {
      const states = await sync.ensureStates();
      return states;
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  // Team page: available to whoever the org chart (server/orgStore.js,
  // edited from the Team page's "Manage team" button) lists as a lead,
  // principal, or scrum member. Not a real security boundary — see the Team
  // page's own framing — but every route still checks it server-side rather
  // than trusting the client to hide the nav item.
  // Returns { allowed, role } rather than just `role` — the owner is
  // `allowed: true` even with `role: null` (no org-chart row yet, created
  // lazily on their first "Manage team" open), which callers must not
  // mistake for a denial.
  async function requireTeamPage(req, reply, force = false) {
    const { sync } = req.session.scope;
    const identity = req.session.identity;
    const [role, isOwner] = await Promise.all([sync.getRoleFor(identity.uniqueName, force), sync.isOwner(identity.uniqueName)]);
    if (!canSeeTeamPage(role, isOwner)) {
      reply.code(403);
      return { allowed: false, role: null };
    }
    return { allowed: true, role };
  }

  app.get('/api/team', async (req, reply) => {
    const { sync } = req.session.scope;
    // Refreshed before the role check too, not just the member list — a
    // person who was JUST added to the org chart as a lead/principal must
    // see the Team page immediately, not wait for the in-memory cache to
    // otherwise refresh. getTeamMembersFor below reads whatever ensureRoles
    // just cached here — it doesn't need its own force.
    const refresh = req.query.refresh === '1' && rolesRefreshLimiter.consume(`${req.session.scope.key}:${req.session.identity.id}`);
    const { allowed, role } = await requireTeamPage(req, reply, refresh);
    if (!allowed) return { error: 'The Team page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const members = await sync.getTeamMembersFor(req.session.identity.uniqueName);
      const groups = sync.getRosterGroupsFor(req.session.identity.uniqueName, members);
      // wikiAvailable false means this project has no `<project>.wiki` (or it
      // couldn't be read), so an empty roster here is "nothing set up in this
      // project yet", not "you have no team" — the client says so rather than
      // rendering a bare empty state.
      return { role, members, groups, wikiAvailable: sync.orgStore.wikiAvailable };
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  // The Scrum page — read-only, gated on the same canSeeTeamPage rule as the
  // Team page (FR-027; research.md R8). Every handler independently
  // re-checks it server-side, per Constitution Principle III — the nav item
  // being hidden client-side is a courtesy only (FR-028).
  function envelope(data) {
    return { computedAt: new Date().toISOString(), stale: false, computing: false, data };
  }

  app.get('/api/scrum/sprints', async (req, reply) => {
    const { sync } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const { sprints, currentPath, excludedNoDates } = await sync.getSprints();
      return envelope({ sprints, currentPath, excludedNoDates });
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  app.get('/api/scrum/velocity', async (req, reply) => {
    const { scrum } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const windowSize = Number(req.query.window) > 0 ? Number(req.query.window) : DEFAULT_SPRINT_WINDOW;
      const data = await scrum.getVelocity({ windowSize });
      return envelope(data);
    } catch (err) {
      reply.code(503);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  app.get('/api/scrum/progress', async (req, reply) => {
    const { scrum } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const data = await scrum.getProgress({ sprintPath: req.query.sprint || null });
      return envelope(data);
    } catch (err) {
      reply.code(503);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  app.get('/api/scrum/utilisation', async (req, reply) => {
    const { scrum } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const data = await scrum.getUtilisation({ sprintPath: req.query.sprint || null });
      return envelope(data);
    } catch (err) {
      reply.code(503);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  app.get('/api/scrum/burndown', async (req, reply) => {
    const { scrum } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const data = await scrum.getBurndown({ sprintPath: req.query.sprint || null });
      return envelope(data);
    } catch (err) {
      reply.code(503);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  app.get('/api/scrum/impediments', async (req, reply) => {
    const { scrum } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const data = await scrum.getImpediments({ sprintPath: req.query.sprint || null });
      return envelope(data);
    } catch (err) {
      reply.code(503);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  app.get('/api/scrum/scope-change', async (req, reply) => {
    const { scrum } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const data = await scrum.getScopeChange({ sprintPath: req.query.sprint || null });
      return envelope(data);
    } catch (err) {
      reply.code(503);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  /** The project-wide administration capability the blocked-convention write
   * requires (FR-035c-ii) — deliberately NOT `requireOrgAdmin`/`canAdminOrg`,
   * which a subtree-scoped team lead also holds. The convention governs
   * every type across the WHOLE project, so authority over one branch of the
   * org chart is not sufficient; only the dashboard owner (project-wide by
   * definition — see sync.isOwner) qualifies. */
  async function requireProjectAdmin(req, reply) {
    const { sync } = req.session.scope;
    const isOwner = await sync.isOwner(req.session.identity.uniqueName);
    if (!isOwner) {
      reply.code(403);
      return false;
    }
    return true;
  }

  app.get('/api/scrum/blocked-convention', async (req, reply) => {
    const { sync, scrum } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    try {
      const [convention, types, states, isOwner, items] = await Promise.all([
        scrum.getBlockedConvention(),
        sync.ensureTypes(),
        sync.ensureStates(),
        sync.isOwner(req.session.identity.uniqueName),
        (async () => {
          const { sprints, currentPath } = await sync.getSprints();
          const sprint = sprints.find((s) => s.path === (req.query.sprint || currentPath));
          return sprint ? scrum._getSprintItems(sprint) : [];
        })(),
      ]);
      const fields = await fetchEligibleBlockedFields(sync.client);
      const options = {
        types: types.allTypes,
        statesByType: states,
        tags: [...new Set(items.flatMap((i) => i.tags))],
        fields,
      };
      const suggestion = await (async () => {
        try {
          const signal = await detectBlockedSignal(sync.client, { types: types.allTypes });
          if (signal.kind === 'state' && signal.types) {
            return { byType: Object.fromEntries(signal.types.map((t) => [t, { states: [signal.value], tags: [], field: null }])), source: 'detector' };
          }
          return null;
        } catch {
          return null;
        }
      })();
      return { data: { convention, configured: Object.keys(convention.byType || {}).length > 0, canEdit: isOwner, options, suggestion } };
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  app.put('/api/scrum/blocked-convention', async (req, reply) => {
    const { sync } = req.session.scope;
    const { allowed } = await requireTeamPage(req, reply);
    if (!allowed) return { error: 'The Scrum page is only available to leads, principals, and scrum accounts.', code: 'VALIDATION' };
    const isAdmin = await requireProjectAdmin(req, reply);
    if (!isAdmin) return { error: 'Only the dashboard owner can change the blocked convention.', code: 'FORBIDDEN' };
    try {
      const [types, states] = await Promise.all([sync.ensureTypes(), sync.ensureStates()]);
      const fields = await fetchEligibleBlockedFields(sync.client);
      // Must match GET's sprint selection exactly (req.query.sprint, falling
      // back to currentPath) — otherwise a convention edited against a
      // non-current sprint's tag options 400s here against currentPath's
      // instead, rejecting a tag the editor itself just offered.
      const { sprints, currentPath } = await sync.getSprints();
      const sprint = sprints.find((s) => s.path === (req.query.sprint || currentPath));
      const items = sprint ? await req.session.scope.scrum._getSprintItems(sprint) : [];
      const options = { types: types.allTypes, statesByType: states, tags: [...new Set(items.flatMap((i) => i.tags))], fields };
      const validated = validateConvention(req.body, options);
      const saved = await sync.orgStore.saveBlockedConvention(validated);
      // Otherwise the standup (impediments) view and the items it's built
      // from keep answering from up to SHORT_TTL_MS-old cache entries that
      // pre-date this convention.
      req.session.scope.scrum.invalidateConventionDependentCaches();
      return { data: { convention: saved } };
    } catch (err) {
      if (err instanceof ValidationError || err.code) {
        reply.code(statusForError(err));
        return errorBody(err, err.code || 'VALIDATION');
      }
      // A plain Error from validateConvention (a name that doesn't exist) is
      // a 400, not an ADO fault.
      reply.code(400);
      return { error: err.message, code: 'VALIDATION' };
    }
  });

  // The org chart backing Team rosters and roles (server/orgStore.js),
  // edited from the Team page's "Manage team" modal. A Lead is scoped to
  // their own subtree; the dashboard owner sees and can edit the entire
  // chart — every team, every member, not just their own descendants (see
  // the isOwner bypasses in OrgStore.assertInSubtree/assertParentInScope
  // and GET /api/org below). Nobody but the owner can edit their own row,
  // and nobody — including the owner — can delete it or change their own
  // role/parent that way; that is what stops a lead promoting themselves
  // and what keeps the chart from ever losing its root.
  async function requireOrgAdmin(req, reply) {
    const { sync } = req.session.scope;
    await sync.ensureRoles(); // ensures the org store is loaded at least once
    const identity = req.session.identity;
    const isOwner = await sync.isOwner(identity.uniqueName);
    if (isOwner && !findMemberByEmail(sync.orgStore.getStore(), identity.uniqueName)) {
      // First time the owner opens Manage Team on a fresh (or ownerless)
      // chart — create their root row so there's something to build
      // downward from. Nobody else is auto-created.
      //
      // This is a WRITE, on the read path of every org route, and it can fail
      // for reasons that are the project's setup rather than the caller's fault
      // (no wiki at all -> WIKI_MISSING). Uncaught, it left Fastify's default
      // handler to answer 500 with its own envelope — which buried the code the
      // client keys its explanation off, so the Team page showed a generic
      // failure for a situation it has specific copy for. Translate it here.
      try {
        await sync.orgStore.ensureOwnerMember(identity.uniqueName, identity.displayName);
      } catch (err) {
        reply.code(statusForError(err));
        req.orgAdminError = errorBody(err, err.code || 'ADO_ERROR');
        return null;
      }
      sync.invalidateRoles();
    }
    const role = await sync.getRoleFor(identity.uniqueName);
    if (!canAdminOrg(role, isOwner)) {
      reply.code(403);
      return null;
    }
    return { uniqueName: identity.uniqueName, role, isOwner };
  }

  // The default when requireOrgAdmin returns null. It sets `req.orgAdminError`
  // instead when the refusal has a more specific reason than "you're not an
  // admin" — see the ensureOwnerMember catch there.
  const ORG_ADMIN_ERROR = { error: 'Manage Team is only available to the dashboard owner and team leads.', code: 'FORBIDDEN' };

  app.get('/api/org', async (req, reply) => {
    const { sync } = req.session.scope;
    const ctx = await requireOrgAdmin(req, reply);
    if (!ctx) return req.orgAdminError || ORG_ADMIN_ERROR;
    // Re-read the wiki every time this screen opens. It's one request on a
    // rarely-opened admin surface, and it buys two things: the chart shown is
    // the real one even if the page was hand-edited in ADO, and the ETag used
    // to guard the next write is current, so an edit made from here doesn't
    // fail an If-Match check against a version we read hours ago.
    await sync.orgStore.reload();
    sync.invalidateRoles();
    const store = sync.orgStore.getStore();
    const { self, memberIds } = sync.orgStore.subtreeFor(ctx.uniqueName);
    // The owner sees and can edit the entire chart — every team, every
    // member — not just their own parentId subtree; a Lead stays scoped to
    // themselves plus their descendants, same as before.
    const members = ctx.isOwner ? store.members : store.members.filter((m) => (self && m.id === self.id) || memberIds.has(m.id));
    const teams = ctx.isOwner
      ? store.teams
      : store.teams.filter((t) => {
          const visibleTeamIds = new Set(members.map((m) => m.teamId).filter(Boolean));
          return visibleTeamIds.has(t.id) || (self && t.managerMemberId === self.id) || memberIds.has(t.managerMemberId);
        });
    return {
      teams,
      members,
      selfMemberId: self ? self.id : null,
      isOwner: ctx.isOwner,
      assignableRoles: assignableRoles(ctx.role, ctx.isOwner),
      // False when this project has no wiki to save the chart to — the modal
      // explains that instead of letting the first save fail (see OrgStore._save).
      wikiAvailable: sync.orgStore.wikiAvailable,
    };
  });

  app.post('/api/org/teams', async (req, reply) => {
    const { sync } = req.session.scope;
    const ctx = await requireOrgAdmin(req, reply);
    if (!ctx) return req.orgAdminError || ORG_ADMIN_ERROR;
    try {
      // Adding a team is a structural change to the chart — a new node, not
      // roster upkeep — same reasoning as reassigning or deleting one (see
      // PATCH/DELETE above). A Lead manages the team(s) they already have,
      // not how many teams exist.
      if (!ctx.isOwner) throw new ForbiddenError('Only the dashboard owner can add a team.');
      // The manager is always explicit. This used to fall back to the
      // caller's own id, which silently made the dashboard owner the lead of
      // every team they created — owner and team lead are separate roles,
      // and the owner heads a team only when actually chosen.
      const managerMemberId = req.body && req.body.managerMemberId;
      if (managerMemberId) assertParentInScope(sync, ctx.uniqueName, managerMemberId, ctx.isOwner);
      const team = await sync.orgStore.createTeam({
        name: req.body && req.body.name,
        managerMemberId,
      });
      return { team };
    } catch (err) {
      reply.code(statusForError(err));
      return errorBody(err, err.code || 'VALIDATION');
    }
  });

  app.patch('/api/org/teams/:id', async (req, reply) => {
    const { sync } = req.session.scope;
    const ctx = await requireOrgAdmin(req, reply);
    if (!ctx) return req.orgAdminError || ORG_ADMIN_ERROR;
    try {
      sync.orgStore.assertCanManageTeam(ctx.uniqueName, req.params.id, ctx.isOwner);
      const body = req.body || {};
      const patch = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.managerMemberId !== undefined) {
        // Reassigning who heads a team — even to someone in your own subtree
        // — is an owner-only action. A Lead may administer their own team's
        // roster, but handing it to someone else (including stepping down
        // themselves) is a structural change to the chart, not team upkeep.
        const currentTeam = findTeam(sync.orgStore.getStore(), req.params.id);
        if (!ctx.isOwner && currentTeam && body.managerMemberId !== currentTeam.managerMemberId) {
          throw new ForbiddenError('Only the dashboard owner can change who leads a team.');
        }
        assertParentInScope(sync, ctx.uniqueName, body.managerMemberId, ctx.isOwner);
        patch.managerMemberId = body.managerMemberId;
      }
      const team = await sync.orgStore.updateTeam(req.params.id, patch);
      return { team };
    } catch (err) {
      reply.code(statusForError(err));
      return errorBody(err, err.code || 'VALIDATION');
    }
  });

  app.delete('/api/org/teams/:id', async (req, reply) => {
    const { sync } = req.session.scope;
    const ctx = await requireOrgAdmin(req, reply);
    if (!ctx) return req.orgAdminError || ORG_ADMIN_ERROR;
    try {
      // Deleting a team is a structural change to the chart, not routine
      // roster upkeep — owner-only, same reasoning as reassigning its lead
      // above. A Lead who could delete their own team could otherwise remove
      // themselves (and everyone on it) from the chart entirely.
      if (!ctx.isOwner) throw new ForbiddenError('Only the dashboard owner can delete a team.');
      sync.orgStore.assertCanManageTeam(ctx.uniqueName, req.params.id, ctx.isOwner);
      // ?cascade=1 is the client saying the "this also deletes N people"
      // confirmation was shown and accepted (see OrgStore.deleteTeam). For a
      // non-owner it must not become a back door around the per-role limits
      // the member routes enforce: a Lead may not delete another Lead one at
      // a time, so they may not do it by deleting the team either.
      const cascade = req.query && (req.query.cascade === '1' || req.query.cascade === 'true');
      if (cascade && !ctx.isOwner) {
        const roster = sync.orgStore.getStore().members.filter((m) => m.teamId === req.params.id);
        const blocked = roster.find((m) => !canAssignRole(ctx.role, ctx.isOwner, m.role));
        if (blocked) throw new ForbiddenError(`You are not allowed to manage a ${blocked.role}, so you cannot delete this team.`);
      }
      await sync.orgStore.deleteTeam(req.params.id, { cascade });
      sync.invalidateRoles();
      return { ok: true };
    } catch (err) {
      reply.code(statusForError(err));
      return errorBody(err, err.code || 'VALIDATION');
    }
  });

  // A written parentId/target must always resolve inside the caller's own
  // subtree — the caller's own id counts as a valid parent (attaching a new
  // person directly under yourself), but the caller's own row is never a
  // valid write TARGET (see requireOrgAdmin's doc comment above). The owner
  // sees the whole chart, so any existing member is a valid parent for them.
  function assertParentInScope(sync, uniqueName, parentId, isOwner = false) {
    if (isOwner) {
      if (!findMember(sync.orgStore.getStore(), parentId)) throw new ValidationError('Unknown parent.');
      return;
    }
    const { self, memberIds } = sync.orgStore.subtreeFor(uniqueName);
    if (parentId === (self && self.id)) return;
    if (memberIds.has(parentId)) return;
    throw new ForbiddenError('That parent is outside your team.');
  }

  app.post('/api/org/members', async (req, reply) => {
    const { sync } = req.session.scope;
    const ctx = await requireOrgAdmin(req, reply);
    if (!ctx) return req.orgAdminError || ORG_ADMIN_ERROR;
    try {
      const { self } = sync.orgStore.subtreeFor(ctx.uniqueName);
      const body = req.body || {};
      // An explicit null parentId creates a chart root — used when a brand
      // new team manager is minted from the Create Team form, since a new
      // manager must NOT be auto-parented under the owner. Only the owner
      // may do that: for anyone else a rootless member would land outside
      // their own subtree and be immediately unmanageable, so they keep the
      // old "under me" fallback and the permission model is unchanged.
      const parentExplicitlyNull = body.parentId === null && ctx.isOwner;
      const parentId = typeof body.parentId === 'string' ? body.parentId : parentExplicitlyNull ? null : self ? self.id : null;
      if (!parentId && !parentExplicitlyNull) throw new ValidationError('No team to add this person under yet.');
      if (parentId) assertParentInScope(sync, ctx.uniqueName, parentId, ctx.isOwner);
      const targetRole = body.role || 'developer';
      if (!canAssignRole(ctx.role, ctx.isOwner, targetRole)) {
        throw new ForbiddenError(`You are not allowed to assign the ${targetRole} role.`);
      }
      const member = await sync.orgStore.createMember({
        email: body.email,
        displayName: body.displayName,
        role: body.role,
        teamId: body.teamId,
        parentId,
      });
      sync.invalidateRoles();
      return { member };
    } catch (err) {
      reply.code(statusForError(err));
      return errorBody(err, err.code || 'VALIDATION');
    }
  });

  app.patch('/api/org/members/:id', async (req, reply) => {
    const { sync } = req.session.scope;
    const ctx = await requireOrgAdmin(req, reply);
    if (!ctx) return req.orgAdminError || ORG_ADMIN_ERROR;
    try {
      // The owner's own row is a valid PATCH target (e.g. joining a team by
      // setting teamId) — everyone else is still blocked from editing
      // themselves, which is what stops self-promotion.
      sync.orgStore.assertInSubtree(ctx.uniqueName, req.params.id, ctx.isOwner);
      const target = findMember(sync.orgStore.getStore(), req.params.id);
      if (!canAssignRole(ctx.role, ctx.isOwner, target.role)) {
        throw new ForbiddenError(`You are not allowed to manage a ${target.role}.`);
      }
      const body = req.body || {};
      const patch = {};
      if (body.displayName !== undefined) patch.displayName = body.displayName;
      if (body.role !== undefined) {
        if (!canAssignRole(ctx.role, ctx.isOwner, body.role)) {
          throw new ForbiddenError(`You are not allowed to assign the ${body.role} role.`);
        }
        patch.role = body.role;
      }
      // Not a stored field — the caller's confirmation that a demotion may
      // move this person's reports up to their own manager first. See
      // OrgStore._validateMemberFields rule 7.
      if (body.reassignReports === true) patch.reassignReports = true;
      if (body.teamId !== undefined) patch.teamId = body.teamId;
      if (body.parentId !== undefined) {
        assertParentInScope(sync, ctx.uniqueName, body.parentId, ctx.isOwner);
        patch.parentId = body.parentId;
      }
      const member = await sync.orgStore.updateMember(req.params.id, patch);
      sync.invalidateRoles();
      return { member };
    } catch (err) {
      reply.code(statusForError(err));
      return errorBody(err, err.code || 'VALIDATION');
    }
  });

  // Self-deletion is never allowed, even for the owner (whose own row is
  // otherwise a valid target above) — deleting it would strand the chart
  // with no root, and there's no "undo" once the wiki save lands.
  app.delete('/api/org/members/:id', async (req, reply) => {
    const { sync } = req.session.scope;
    const ctx = await requireOrgAdmin(req, reply);
    if (!ctx) return req.orgAdminError || ORG_ADMIN_ERROR;
    try {
      // The owner administers the whole chart — every team, every member —
      // exactly as they already can on PATCH. This used to omit `isOwner`,
      // which quietly limited the owner to their own parentId subtree; since
      // the owner deliberately sits outside the reporting hierarchy that
      // subtree is empty, so the owner could delete nobody at all.
      const { self } = sync.orgStore.subtreeFor(ctx.uniqueName);
      if (self && self.id === req.params.id) {
        throw new ForbiddenError('You cannot delete your own entry.');
      }
      sync.orgStore.assertInSubtree(ctx.uniqueName, req.params.id, ctx.isOwner);
      const target = findMember(sync.orgStore.getStore(), req.params.id);
      if (!canAssignRole(ctx.role, ctx.isOwner, target.role)) {
        throw new ForbiddenError(`You are not allowed to manage a ${target.role}.`);
      }
      await sync.orgStore.deleteMember(req.params.id);
      sync.invalidateRoles();
      return { ok: true };
    } catch (err) {
      reply.code(statusForError(err));
      return errorBody(err, err.code || 'VALIDATION');
    }
  });

  app.get('/api/dashboard', async (req, reply) => {
    const { sync } = req.session.scope;
    const person = await sync.resolvePerson(req.session.identity, req.query.person);
    if (!person) {
      reply.code(404);
      return { error: 'Unknown person.', code: 'VALIDATION' };
    }

    // A previous (fire-and-forget) sync of THIS caller's own dashboard
    // already came back with an unambiguous dead-token 401 — surfaced now
    // rather than re-triggering another doomed sync or continuing to serve
    // a cache that will never refresh again. See handleSelfSyncError and
    // SyncEngine.selfSyncErrors.
    const priorSelfError = handleSelfSyncError(sync.selfSyncErrors.get(person.id), person, req.session.scope.readToken, reply, SESSION_COOKIE);
    if (priorSelfError) return priorSelfError;

    const cached = sync.getCachedDashboard(person.id);
    if (cached) {
      // Serve instantly, but if it's old enough revalidate in the
      // background — otherwise a teammate's dashboard, once cached, would
      // never refresh again since nothing else polls for them.
      if (sync.isStale(cached)) {
        sync.syncPerson(person).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[sync] background revalidate failed for ${person.displayName}:`, err.message);
        });
      }
      // isSelf is overridden here rather than trusted from the cached
      // payload: the same dashboard-v2-<id> cache entry can be resynced by
      // different people's sessions (e.g. a lead's Team page background-
      // revalidating a teammate's stale dashboard), so whatever isSelf got
      // baked in last doesn't necessarily reflect THIS caller. Recomputed
      // fresh every request from `person`, which is always resolved
      // relative to req.session.identity.
      return { ...cached, isSelf: person.isSelf };
    }

    // Nothing cached yet: kick the sync off (deduped per person) and let the
    // client poll — the 202 path already drives the loading state. If THIS
    // attempt itself fails with the caller's own dead token, the next poll
    // is what catches it via priorSelfError above — no need to await here,
    // which would block a cold sync's first response for as long as a full
    // revision-index walk takes.
    sync.syncPerson(person).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[sync] on-demand sync failed for ${person.displayName}:`, err.message);
    });
    reply.code(202);
    return { status: 'syncing', message: 'Sync in progress, retry shortly.' };
  });

  // Pages one repo's PR list, attributing only the PRs in that page — see
  // server/sync.js's PR index (the cheap, unattributed tier the dashboard
  // payload's `prRepos` summaries are also built from) and
  // server/ado/prAttribution.js's candidate cache, which makes repeat
  // attribution of the same PR nearly free.
  app.get('/api/pullrequests', async (req, reply) => {
    const { sync } = req.session.scope;
    // Attribution candidates are keyed by PR id, and pull requests are
    // org-scoped by design (see server/ado/pullrequests.js) — so this cache is
    // shared across projects rather than duplicated per scope, which is what
    // stops every project from re-paying 2 ADO requests per PR.
    const cache = registry.orgCache;
    const role = await sync.getRoleFor(req.session.identity.uniqueName);
    if (!canSeePullRequests(role)) {
      reply.code(403);
      return { error: 'Pull Requests are not available on a scrum account.', code: 'FORBIDDEN' };
    }
    const person = await sync.resolvePerson(req.session.identity, req.query.person);
    if (!person) {
      reply.code(404);
      return { error: 'Unknown person.', code: 'VALIDATION' };
    }

    const repositoryId = typeof req.query.repo === 'string' ? req.query.repo : '';
    if (!repositoryId) {
      reply.code(400);
      return { error: 'Missing required "repo" query param.', code: 'VALIDATION' };
    }

    const index = sync.getPrIndex(person.id);
    if (!index) {
      // Same dead-token shortcut as GET /api/dashboard: a previous
      // fire-and-forget sync of the caller's own PR index already failed
      // with an unambiguous 401 — end the session now instead of
      // re-triggering another doomed sync.
      const priorSelfError = handleSelfSyncError(sync.selfSyncErrors.get(person.id), person, req.session.scope.readToken, reply, SESSION_COOKIE);
      if (priorSelfError) return priorSelfError;

      // No sync has completed for this person yet — same on-demand-sync +
      // 202 convention as GET /api/dashboard; the client's fetch wrapper
      // already retries on this.
      sync.syncPerson(person).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[sync] on-demand sync failed for ${person.displayName}:`, err.message);
      });
      reply.code(202);
      return { status: 'syncing', message: 'Sync in progress, retry shortly.' };
    }

    if (!prPageLimiter.consume(`${req.session.scope.key}:${person.id}`)) {
      reply.code(429);
      return { error: 'Too many pull request requests — slow down.', code: 'RATE_LIMITED' };
    }

    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    // Comma-joined so the client's multi-select status chips (any-of) can
    // combine with the Dashboard stat tile's single ?status= link
    // (narrows to exactly one) into one allowed set — see
    // PullRequestsPage's `allowedStatuses`.
    const statuses = typeof req.query.status === 'string' && req.query.status
      ? new Set(req.query.status.split(',').filter(Boolean))
      : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    const forRepo = (pr) => (pr.repositoryId || pr.repository) === repositoryId;
    const repoMeta = index.prs.find(forRepo) || null;

    try {
      let candidates = index.prs.filter(forRepo);
      if (statuses) candidates = candidates.filter((pr) => statuses.has(prStatusId(pr)));

      if (q) {
        const lowerQ = q.toLowerCase();
        // The common, cheap case: the PR's own id or title needs no
        // attribution. Ranked so an exact/prefix id match leads a title
        // match — "12" shouldn't bury PR #12 under every PR containing
        // "12" in its title.
        const cheap = candidates.filter((pr) => prCheapMatch(pr, q, lowerQ));
        if (cheap.length > 0) {
          candidates = cheap.sort((a, b) => rankPrMatch(a, q) - rankPrMatch(b, q));
        } else {
          // Falls back to attributing a bounded, most-recent slice of this
          // ONE repo so a search can also match the story/linked-item ids a
          // PR resolved to — never the whole repo's history, which would
          // reintroduce the per-PR HTTP cost this endpoint exists to avoid.
          const bounded = candidates.slice(0, SEARCH_ATTRIBUTION_CAP);
          const searchAttribution = await attributePullRequests(sync.client, bounded, null, cache, { storyTypes: (await sync.ensureTypes()).storyTypes });
          candidates = bounded.filter((pr) => {
            const attr = searchAttribution.get(pr.id);
            if (!attr) return false;
            if (attr.story && String(attr.story.id).includes(q)) return true;
            return attr.linkedItems.some((item) => String(item.id).includes(q));
          });
        }
      }

      const total = candidates.length;
      const page = candidates.slice(offset, offset + limit);
      const attribution = await attributePullRequests(sync.client, page, null, cache, { storyTypes: (await sync.ensureTypes()).storyTypes });
      const [group] = buildRepoPrGroups(page, attribution);

      return {
        repository: repoMeta ? repoMeta.repository : null,
        repositoryId,
        projectName: repoMeta ? repoMeta.projectName : null,
        stories: group ? group.stories : [],
        unattributed: group ? group.unattributed : [],
        total,
        offset,
        limit,
        hasMore: offset + limit < total,
      };
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  // Which repos actually have a match for the current status/search filter —
  // one request, no per-repo fan-out. Backs the client's "only render repos
  // that have something to show" rule: without this, a filtered Pull
  // Requests page either rendered every repo (most empty) or had to open
  // every repo's own paged query just to find out which had zero results,
  // both of which are what drove requests into prPageLimiter hard enough to
  // 429. Status/id/title matching is free (already on the PR index); only
  // the linked-work-item-id fallback needs attribution, capped globally
  // here rather than per repo per page as GET /api/pullrequests does.
  app.get('/api/pullrequests/repos', async (req, reply) => {
    const { sync } = req.session.scope;
    const cache = registry.orgCache;
    const role = await sync.getRoleFor(req.session.identity.uniqueName);
    if (!canSeePullRequests(role)) {
      reply.code(403);
      return { error: 'Pull Requests are not available on a scrum account.', code: 'FORBIDDEN' };
    }
    const person = await sync.resolvePerson(req.session.identity, req.query.person);
    if (!person) {
      reply.code(404);
      return { error: 'Unknown person.', code: 'VALIDATION' };
    }

    const index = sync.getPrIndex(person.id);
    if (!index) {
      const priorSelfError = handleSelfSyncError(sync.selfSyncErrors.get(person.id), person, req.session.scope.readToken, reply, SESSION_COOKIE);
      if (priorSelfError) return priorSelfError;

      sync.syncPerson(person).catch((err) => {
        // eslint-disable-next-line no-console
        console.error(`[sync] on-demand sync failed for ${person.displayName}:`, err.message);
      });
      reply.code(202);
      return { status: 'syncing', message: 'Sync in progress, retry shortly.' };
    }

    if (!prPageLimiter.consume(`${req.session.scope.key}:${person.id}`)) {
      reply.code(429);
      return { error: 'Too many pull request requests — slow down.', code: 'RATE_LIMITED' };
    }

    const statuses = typeof req.query.status === 'string' && req.query.status
      ? new Set(req.query.status.split(',').filter(Boolean))
      : null;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    try {
      let candidates = index.prs;
      if (statuses) candidates = candidates.filter((pr) => statuses.has(prStatusId(pr)));

      if (q) {
        const lowerQ = q.toLowerCase();
        const cheap = candidates.filter((pr) => prCheapMatch(pr, q, lowerQ));
        const rest = candidates.filter((pr) => !prCheapMatch(pr, q, lowerQ));
        let attributedMatches = [];
        if (rest.length > 0) {
          const bounded = rest.slice(0, SEARCH_ATTRIBUTION_CAP);
          const searchAttribution = await attributePullRequests(sync.client, bounded, null, cache, { storyTypes: (await sync.ensureTypes()).storyTypes });
          attributedMatches = bounded.filter((pr) => {
            const attr = searchAttribution.get(pr.id);
            if (!attr) return false;
            if (attr.story && String(attr.story.id).includes(q)) return true;
            return attr.linkedItems.some((item) => String(item.id).includes(q));
          });
        }
        candidates = [...cheap, ...attributedMatches];
      }

      const counts = new Map();
      for (const pr of candidates) {
        if (!pr.repository) continue;
        const key = pr.repositoryId || pr.repository;
        if (!counts.has(key)) {
          counts.set(key, {
            repositoryId: pr.repositoryId || null,
            repository: pr.repository,
            projectName: pr.projectName || null,
            matchCount: 0,
          });
        }
        counts.get(key).matchCount += 1;
      }

      return { repos: [...counts.values()].sort((a, b) => b.matchCount - a.matchCount) };
    } catch (err) {
      reply.code(502);
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  // Polled by the client (~every 1.5s per open Team section) while a sync is
  // running — its own tiny route rather than a field on /api/dashboard,
  // since re-serializing the whole dashboard payload at that rate would not
  // be free. Returns `{ progress: null }` once nothing is in flight for this
  // person, which is also the client's signal to stop polling.
  /**
   * Cross-project hours: the same hours-per-day series as the dashboard's
   * card, summed over every project the CALLER's token can read, with each
   * breakdown row carrying the project it came from.
   *
   * `?person=` asks the same question about a teammate, which is what the
   * Team page's card uses. Two people are involved and they have different
   * jobs (see server/crossHours.js): the caller's PAT lists and reads the
   * projects, the named person is only the `changedBy` filter. So this
   * answers "the hours <person> logged, in the projects <caller> can read" —
   * never an escalation, since every project walked is one the caller could
   * have opened themselves.
   *
   * Gated on the Team page permission for a teammate, since that is the
   * feature it serves; your own hours need no role at all.
   *
   * Answers immediately either way: `{status:'building'}` with progress while
   * a first build runs (which can take minutes if several projects have never
   * been opened), or the result — served from cache and rebuilt behind the
   * response once it ages past FRESH_MS.
   */
  app.get('/api/hours/cross', async (req, reply) => {
    if (!crossHoursLimiter.consume(req.session.identity.id)) {
      reply.code(429);
      return { error: 'Too many requests — try again in a moment.', code: 'RATE_LIMITED' };
    }
    const { sync } = req.session.scope;
    const identity = req.session.identity;
    const person = await sync.resolvePerson(identity, req.query.person);
    if (!person) {
      reply.code(404);
      return { error: 'Unknown person.', code: 'VALIDATION' };
    }
    if (!person.isSelf) {
      const gate = await requireTeamPage(req, reply);
      if (!gate.allowed) return { error: 'Not available for this account.', code: 'FORBIDDEN' };
    }
    return crossHours.request(
      {
        id: identity.id,
        displayName: identity.displayName,
        uniqueName: identity.uniqueName,
        pat: req.session.pat,
      },
      // identities: passed through (006-linked-identity-aliases, T035) so
      // the cross-project walk sums hours over the whole identity set, not
      // just the primary — see CrossHours._build.
      { id: person.id, displayName: person.displayName, uniqueName: person.uniqueName, identities: person.identities }
    );
  });

  app.get('/api/sync/progress', async (req, reply) => {
    const { sync } = req.session.scope;
    const person = await sync.resolvePerson(req.session.identity, req.query.person);
    if (!person) {
      reply.code(404);
      return { error: 'Unknown person.', code: 'VALIDATION' };
    }
    return { progress: sync.getProgress(person.id) };
  });

  app.post('/api/sync', async (req, reply) => {
    const { sync } = req.session.scope;
    const person = await sync.resolvePerson(req.session.identity, req.body && req.body.person);
    if (!person) {
      reply.code(404);
      return { error: 'Unknown person.', code: 'VALIDATION' };
    }
    try {
      const dashboard = await sync.syncPerson(person);
      return { status: 'ok', syncedAt: dashboard.syncedAt };
    } catch (err) {
      // This reads through the scope's shared read token, never the caller's
      // own PAT — statusForError remaps a bare ADO 401 to 403 specifically
      // so it's never mistaken by the client for THIS person's session
      // being dead (see web/src/lib/api.ts's redirectToLogin). A dead
      // read token surfaces via the /api/auth/me banner instead — see
      // sync.readTokenInvalid.
      reply.code(statusForError(err));
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  // "Reload All Data": forces the shared 24h caches (sprints, roster,
  // states) and the requester's dashboard to refetch immediately, then
  // resyncs every other person with a cached dashboard in the background —
  // see SyncEngine.fullResync. Unlike /api/cache/clear this never touches
  // the revision index, so it stays fast (seconds, not the ~78s a cold
  // index rebuild takes). Restricted to the configured owner (see
  // sync.isOwner) — project-wide and expensive, not a per-person action.
  app.post('/api/sync/full', async (req, reply) => {
    const { sync } = req.session.scope;
    if (!(await sync.isOwner(req.session.identity.uniqueName))) {
      reply.code(403);
      return { error: 'Only the dashboard owner can reload all data.', code: 'FORBIDDEN' };
    }
    const person = await sync.resolvePerson(req.session.identity, req.body && req.body.person);
    if (!person) {
      reply.code(404);
      return { error: 'Unknown person.', code: 'VALIDATION' };
    }
    // Limiter keys carry the scope: one person working across two projects
    // must not be rate-limited on one because of the other.
    if (!fullSyncLimiter.consume(`${req.session.scope.key}:${person.id}`)) {
      reply.code(429);
      return { error: 'Please wait a moment before reloading again.', code: 'RATE_LIMITED' };
    }
    try {
      const result = await sync.fullResync(person);
      return { status: 'ok', ...result };
    } catch (err) {
      reply.code(statusForError(err));
      return { error: err.message, code: 'ADO_ERROR' };
    }
  });

  // Write-back: always re-reads the task from Azure DevOps first and uses
  // rev-based optimistic concurrency (see server/ado/writeback.js) — never
  // trusts the dashboard's cached payload for a value it's about to change.
  //
  // Writes are restricted to your own work: they run under YOUR PAT
  // (req.session.client), so editing a teammate's task would record the
  // change under your name on work that isn't yours. The UI hides the
  // controls; this `person.isSelf` check is the first backstop — but every
  // write endpoint resolves to self by construction (there is no "write as
  // someone else"; `person` always comes from the caller's own session), so
  // on its own this only proves the caller IS who their session says — not
  // that the target item IS THEIRS. The real enforcement is `person.id`
  // passed through as `expectedAssigneeId` to sync.writeTaskHours, which
  // rejects (403) if the work item's actual AssignedTo doesn't match — see
  // ado/writeback.js assertAssignedTo.
  function writeHandler(computeFor) {
    return async (req, reply) => {
      const { sync } = req.session.scope;
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        reply.code(400);
        return { error: 'Invalid task id.', code: 'VALIDATION' };
      }

      const person = await sync.resolvePerson(req.session.identity, req.body && req.body.person);
      if (!person || !person.isSelf) {
        reply.code(403);
        return { error: 'You can only log hours on your own tasks.', code: 'VALIDATION' };
      }

      try {
        return await sync.writeTaskHours(req.session.client, id, computeFor(req), person);
      } catch (err) {
        return handleWriteError(err, reply, SESSION_COOKIE);
      }
    };
  }

  app.post(
    '/api/tasks/:id/log-hours',
    writeHandler((req) => (current) => computeLogHours(current, Number(req.body && req.body.hours)))
  );

  app.post(
    '/api/tasks/:id/set-progress',
    writeHandler((req) => (current) => computeSetProgress(current, Number(req.body && req.body.pct)))
  );

  // Live read used by the edit panel before it previews a change — the
  // dashboard's cached hours can be stale (see writeback.js's own comment on
  // fetchCurrentTaskHours), and previewing against a stale estimate is
  // exactly what let a 3.0h preview save as 2.8h. Same self-only rule as the
  // writes, even though this doesn't write anything, so a teammate's task
  // hours can't be probed from your session.
  app.get('/api/tasks/:id/hours', async (req, reply) => {
    const { sync } = req.session.scope;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      reply.code(400);
      return { error: 'Invalid task id.', code: 'VALIDATION' };
    }
    const person = await sync.resolvePerson(req.session.identity, req.query.person);
    if (!person || !person.isSelf) {
      reply.code(403);
      return { error: 'You can only view hours for your own tasks.', code: 'VALIDATION' };
    }
    try {
      const current = await fetchCurrentTaskHours(req.session.client, id);
      return { estimated: current.estimated, completed: current.completed, remaining: current.remaining, state: current.state };
    } catch (err) {
      return handleWriteError(err, reply, SESSION_COOKIE);
    }
  });

  // Manual state change (e.g. moving a story from New to Active by hand).
  // Same self-only rule as the hour-logging endpoints, enforced the same
  // way: the UI hides the control for anyone else's dashboard, and this is
  // the server-side backstop.
  app.post('/api/workitems/:id/state', async (req, reply) => {
    const { sync } = req.session.scope;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      reply.code(400);
      return { error: 'Invalid work item id.', code: 'VALIDATION' };
    }
    const newState = req.body && req.body.state;
    if (!newState || typeof newState !== 'string') {
      reply.code(400);
      return { error: 'A target state is required.', code: 'VALIDATION' };
    }

    const person = await sync.resolvePerson(req.session.identity, req.body && req.body.person);
    if (!person || !person.isSelf) {
      reply.code(403);
      return { error: 'You can only change the state of your own work items.', code: 'VALIDATION' };
    }

    try {
      return await sync.writeState(req.session.client, id, newState, person);
    } catch (err) {
      return handleWriteError(err, reply, SESSION_COOKIE);
    }
  });

  // Moves a task/bug onto its parent story's current sprint — the fix for a
  // story that got moved to a new iteration without dragging its children
  // along. The target iteration is never taken from the request body; it's
  // resolved server-side from the item's real parent (see
  // ado/writeback.js applyMoveToParentIteration). Same self-only rule as
  // every other write endpoint.
  app.post('/api/workitems/:id/move-to-parent-iteration', async (req, reply) => {
    const { sync } = req.session.scope;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      reply.code(400);
      return { error: 'Invalid work item id.', code: 'VALIDATION' };
    }

    const person = await sync.resolvePerson(req.session.identity, req.body && req.body.person);
    if (!person || !person.isSelf) {
      reply.code(403);
      return { error: 'You can only move your own work items.', code: 'VALIDATION' };
    }

    try {
      return await sync.writeIteration(req.session.client, id, person);
    } catch (err) {
      return handleWriteError(err, reply, SESSION_COOKIE);
    }
  });

  // Bulk equivalent: moves every one of a story's children that the caller
  // owns and that isn't already on the story's sprint. Ownership is
  // enforced per-child inside applyMoveChildrenToStoryIteration (a story
  // can carry other people's tasks too), not by this route — this only
  // gates that the CALLER is who they claim to be, same as every other
  // write endpoint.
  app.post('/api/stories/:id/move-children-to-iteration', async (req, reply) => {
    const { sync } = req.session.scope;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      reply.code(400);
      return { error: 'Invalid story id.', code: 'VALIDATION' };
    }

    const person = await sync.resolvePerson(req.session.identity, req.body && req.body.person);
    if (!person || !person.isSelf) {
      reply.code(403);
      return { error: 'You can only move your own work items.', code: 'VALIDATION' };
    }

    try {
      return await sync.writeStoryChildrenIteration(req.session.client, id, person);
    } catch (err) {
      return handleWriteError(err, reply, SESSION_COOKIE);
    }
  });

  // Server-Sent Events: tells the client "data changed, refetch" instead of
  // shipping the payload twice or making the client poll.
  app.get('/api/stream', (req, reply) => {
    const { scope } = req.session;
    const { sync } = scope;
    const myId = req.session.identity.id;
    // A held scope is never evicted while this stream is open — otherwise the
    // engine this listener is attached to could be dropped underneath it and
    // the tab would go quiet with no way to notice.
    const release = registry.retain(scope);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write('retry: 5000\n\n');

    // Filtered to the connected person's own dashboard updates — with
    // multiple people now sharing this server, broadcasting every sync to
    // every open tab would both wake up unrelated browsers and leak whose
    // dashboards are being synced. Teammates' dashboards (Team page) are
    // never background-polled anyway — see docs/invariants.md — so this never needs
    // to carry anyone else's updates.
    const unsubscribe = sync.onUpdate((dashboard) => {
      if (dashboard.person.id !== myId) return;
      reply.raw.write(`event: dashboard-updated\ndata: ${JSON.stringify({ syncedAt: dashboard.syncedAt, personId: dashboard.person.id })}\n\n`);
    });

    // Piggybacks on the existing heartbeat tick rather than adding a second
    // timer: if a sync of this connection's own identity has come back with
    // an unambiguous dead-token 401 (see SyncEngine.selfSyncErrors, set by
    // syncPerson), an idle tab relying solely on this stream — no other
    // request in flight to carry a 401 — would otherwise sit open
    // indefinitely with no further events. Ending the connection here is
    // enough: the client's next ordinary request (or its own reconnect)
    // picks up the 401 PAT_EXPIRED response GET /api/dashboard now sends.
    const heartbeat = setInterval(() => {
      if (sync.selfSyncErrors.has(myId)) {
        reply.raw.end();
        return;
      }
      reply.raw.write(': ping\n\n');
    }, 25000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      release();
    });
  });

  if (process.env.NODE_ENV === 'production') {
    app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url && req.raw.url.startsWith('/api')) {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}

async function main() {
  const config = loadConfig();
  if (config.demo) {
    // The demo organization lives in memory, so caches built from an earlier
    // run would describe data that no longer exists.
    for (const dir of [config.cacheDir, config.orgDataDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    }
    require('./demo').reseed({ seed: config.demoSeed });
  }
  const registry = createScopeRegistry(config);
  const crossHours = new CrossHours({ registry, config, cache: registry.orgCache });
  const app = await buildApp({ config, registry, crossHours });

  registry.startPolling(config.syncIntervalMs);

  await app.listen({ port: config.port, host: config.host });
  // eslint-disable-next-line no-console
  console.log(`\n  Azure DevOps dashboard running at http://${config.host}:${config.port}\n`);
  if (config.demo) {
    // eslint-disable-next-line no-console
    console.log(`  DEMO MODE — serving fictional organization "${config.org}" on port ${config.port}; no Azure DevOps calls will be made.\n`);
  }
}

module.exports = { buildApp };

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
