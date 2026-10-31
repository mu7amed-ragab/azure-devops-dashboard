/**
 * Feature 003 (the original design notes): a caller's own dashboard
 * sync failing with an unambiguous dead-token 401 must end their session with
 * `401 PAT_EXPIRED` instead of an indefinite `202 syncing`/stale-cache loop —
 * see contracts/api-changes.md. Drives the real Fastify app (same `buildApp`
 * as production) through `app.inject()`, with a fake `AdoClient`
 * (test/fixtures/fakeClient.js) standing in for Azure DevOps, following the
 * same pattern as test/scrumHttpPermissions.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { buildApp } = require('../server/index');
const { createScopeRegistry } = require('../server/scopes');
const { CrossHours } = require('../server/crossHours');
const { deriveKey, seal } = require('../server/auth');
const { createFakeClient } = require('./fixtures/fakeClient');
const { AGILE } = require('./fixtures/processes');

const SESSION_COOKIE = 'azdash_session';
const PROJECT = { id: 'dddddddd-2222-2222-2222-222222222222', name: 'ProjectD' };
const SELF = { id: 'u1', displayName: 'Self Person', uniqueName: 'self@test.org' };
const TEAMMATE = { id: 'u2', displayName: 'Teammate', uniqueName: 'teammate@test.org' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-autologout-${label}-`));
}

/** Wraps a fakeClient so its `get`/`post`/`request` reject every call with a
 * bare 401 (the "dead token" signal `isPatExpired` in server/index.js
 * treats as unambiguous) once `dead.value` is set to true — left alive
 * until then so a full sync pass (including `ensureDiscovery`'s
 * `getIdentity`, which reaches the org-scoped connectionData URL via
 * `client.request` rather than `client.get` — see ado/discovery.js) can
 * succeed once, the way a real healthy sync does. `fakeClient.request()`
 * has no case for connectionData at all, so it's answered directly here. */
function withDeadTokenSwitch(client) {
  const dead = { value: false };
  return {
    wrapped: {
      ...client,
      async get(apiPath, options) {
        if (dead.value) throw Object.assign(new Error('token revoked'), { status: 401 });
        return client.get(apiPath, options);
      },
      async post(apiPath, body) {
        if (dead.value) throw Object.assign(new Error('token revoked'), { status: 401 });
        return client.post(apiPath, body);
      },
      async request(url, options) {
        if (dead.value) throw Object.assign(new Error('token revoked'), { status: 401 });
        if (String(url).includes('/_apis/connectionData')) {
          return {
            authenticatedUser: {
              id: SELF.id,
              providerDisplayName: SELF.displayName,
              properties: { Account: { $value: SELF.uniqueName } },
            },
          };
        }
        return client.request(url, options);
      },
    },
    dead,
  };
}

/** Same construction as test/scrumHttpPermissions.test.js's buildTestApp:
 * the real app wired to one pre-seeded, faked scope, plus a cookieFor()
 * helper sealing a real session cookie the same way sign-in would. */
async function buildTestApp() {
  const root = tmpRoot('http');
  const baseConfig = {
    org: 'test-org',
    pat: null,
    apiVersion: '7.1',
    port: 0,
    host: '127.0.0.1',
    cacheDir: path.join(root, '.cache'),
    webDist: path.join(root, 'web-dist'),
    ownerEmail: '',
    rolesWikiPage: '/Dashboard Roles Test',
    dataDir: path.join(root, 'data'),
    orgDataDir: path.join(root, 'data', 'org'),
    maxProjectScopes: 8,
    prHistoryMonths: 12,
    appPassword: 'test-password',
    sessionSecret: 'a-test-session-secret-at-least-32-bytes-long',
    sessionTtlHours: 24,
    authEnabled: true,
    defaultProject: null,
    syncIntervalMs: 900000,
  };

  const registry = createScopeRegistry(baseConfig);
  const crossHours = new CrossHours({ registry, config: baseConfig, cache: registry.orgCache });
  const app = await buildApp({ config: baseConfig, registry, crossHours });
  await app.ready();

  const scope = await registry.getScope(PROJECT, { pat: 'irrelevant', identity: SELF });
  const fakeClient = createFakeClient({ project: PROJECT.name, process: AGILE });
  const { wrapped, dead } = withDeadTokenSwitch(fakeClient);
  scope.sync.setClient(wrapped);
  scope.sync.iterationMap = new Map([
    ['Sprint 1', { id: 1, name: 'Sprint 1', path: 'Sprint 1', startDate: '2020-01-01', finishDate: '2020-01-14' }],
  ]);
  // Seeded directly (rather than via a live fetchPeople WIQL round-trip) so
  // ?person=<TEAMMATE.id> resolves without further fakeClient plumbing —
  // mirrors how iterationMap is pre-seeded above.
  scope.sync.people = [
    { id: SELF.id, displayName: SELF.displayName, uniqueName: SELF.uniqueName },
    { id: TEAMMATE.id, displayName: TEAMMATE.displayName, uniqueName: TEAMMATE.uniqueName },
  ];

  const sessionKey = deriveKey(baseConfig.sessionSecret);
  function cookieFor(identity) {
    const token = seal(
      // pat: '' (not a real token string) deliberately, unlike the initial
      // registry.getScope() call above: server/scopes.js's getScope()
      // self-heals a scope whose readTokenInvalid is true by re-electing
      // and rebuilding a brand-new REAL AdoClient as soon as any caller
      // presents a truthy credentials.pat — exactly what a person signing
      // in again with a fresh token should trigger in production. This
      // fixture's whole point is the person who has NOT done that yet
      // (their session cookie's token is unchanged since it died), so a
      // falsy pat here keeps every request routed through the fake client
      // this test controls, matching that scenario instead of accidentally
      // exercising the (unrelated, already-working) self-heal path.
      { id: identity.id, displayName: identity.displayName, uniqueName: identity.uniqueName, iat: Date.now(), project: PROJECT, pat: '' },
      sessionKey
    );
    return `${SESSION_COOKIE}=${token}`;
  }

  return { app, cookieFor, scope, dead };
}

/** Polls GET /api/dashboard (or another sync-backed route) until it stops
 * answering 202 SYNCING — mirrors what the real client's retry loop does,
 * needed here because syncPerson() is fire-and-forget from the route's
 * point of view. */
async function pollUntilSettled(app, url, cookie, { maxAttempts = 50 } = {}) {
  let res;
  for (let i = 0; i < maxAttempts; i += 1) {
    res = await app.inject({ method: 'GET', url, headers: { cookie } });
    if (res.statusCode !== 202) return res;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return res;
}

suite('Auto logout on invalid token (the original design notes)');

test('GET /api/dashboard: own identity, dead token from the start -> 401 PAT_EXPIRED with session cookie cleared', async () => {
  const { app, cookieFor, dead } = await buildTestApp();
  dead.value = true;
  const cookie = cookieFor(SELF);

  const res = await pollUntilSettled(app, '/api/dashboard', cookie);
  assert.strictEqual(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.payload}`);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.code, 'PAT_EXPIRED');
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie, 'expected a Set-Cookie header clearing the session');
  const cleared = (Array.isArray(setCookie) ? setCookie : [setCookie]).some(
    (c) => c.startsWith(`${SESSION_COOKIE}=;`) || c.includes(`${SESSION_COOKIE}=;`)
  );
  assert.ok(cleared, `expected ${SESSION_COOKIE} to be cleared, got: ${setCookie}`);
});

test('GET /api/dashboard: own identity, cache goes stale then the token dies -> next request answers 401, not the stale cache', async () => {
  const { app, cookieFor, dead, scope } = await buildTestApp();
  const cookie = cookieFor(SELF);

  // Seed a cached dashboard directly rather than driving a full, genuinely
  // successful sync through this fixture (which would need /wit/wiql
  // support fakeClient doesn't provide — orthogonal to what this test is
  // about: an already-cached payload going stale, then failing to
  // revalidate). Backdated past STALE_AFTER_MS (server/sync.js) so the
  // next request's isStale() check fires a background revalidation
  // immediately instead of waiting out the real 5-minute window.
  scope.sync.cache.set(scope.sync._cacheKey(SELF.id), {
    person: { id: SELF.id, displayName: SELF.displayName },
    isSelf: true,
    partial: false,
    syncedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });

  // Now the token dies. The request that observes the stale cache still
  // gets served that stale payload once (existing, unchanged behavior) —
  // it's the background revalidation THIS triggers that fails, caught by
  // the NEXT request via SyncEngine.selfSyncErrors.
  dead.value = true;
  const staleServe = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
  assert.strictEqual(staleServe.statusCode, 200, `the stale cache is still served once, got ${staleServe.statusCode}: ${staleServe.payload}`);

  let res;
  for (let i = 0; i < 50; i += 1) {
    res = await app.inject({ method: 'GET', url: '/api/dashboard', headers: { cookie } });
    if (res.statusCode === 401) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.strictEqual(res.statusCode, 401, `expected eventual 401 once the stale-cache revalidation fails, got ${res.statusCode}: ${res.payload}`);
  assert.strictEqual(JSON.parse(res.payload).code, 'PAT_EXPIRED');
});

test('GET /api/dashboard: a teammate\'s dead-token sync does not clear the caller\'s own session', async () => {
  const { app, cookieFor, dead, scope } = await buildTestApp();
  dead.value = true;
  const selfCookie = cookieFor(SELF);

  const res = await pollUntilSettled(app, `/api/dashboard?person=${TEAMMATE.id}`, selfCookie);
  // Unchanged existing contract: still 202 (or an eventual non-401 outcome),
  // never a 401 that would sign the VIEWING caller out over a teammate's
  // sync failure.
  assert.notStrictEqual(res.statusCode, 401, `a teammate's dead-token sync must not 401 the caller, got ${res.statusCode}: ${res.payload}`);
  assert.ok(!res.headers['set-cookie'], `a teammate's sync failure must not clear the caller's session cookie, got: ${res.headers['set-cookie']}`);

  // The caller's own session state must be untouched by the teammate's
  // failed sync: selfSyncErrors is keyed by person, and only ever set when
  // person.isSelf — a teammate's (isSelf: false) failure must never record
  // an entry under the CALLER's own id.
  assert.ok(!scope.sync.selfSyncErrors.has(SELF.id), 'the caller\'s own id must have no recorded self-sync error from a teammate\'s failure');
});

test('GET /api/dashboard: a non-401 failure (e.g. a 409 conflict) does not trigger PAT_EXPIRED', async () => {
  const { app, cookieFor, scope } = await buildTestApp();
  const cookie = cookieFor(SELF);

  // Swap in a client that fails every call with a 409 rather than a 401 —
  // isPatExpired must not misclassify this as a dead token.
  scope.sync.setClient({
    ...scope.sync.client,
    async get() {
      throw Object.assign(new Error('conflict'), { status: 409 });
    },
  });

  const res = await pollUntilSettled(app, '/api/dashboard', cookie);
  assert.notStrictEqual(res.statusCode, 401, `a non-401 failure must not trigger PAT_EXPIRED, got ${res.statusCode}: ${res.payload}`);
});

test('GET /api/pullrequests: own identity, dead token -> 401 PAT_EXPIRED', async () => {
  const { app, cookieFor, dead } = await buildTestApp();
  dead.value = true;
  const cookie = cookieFor(SELF);

  const res = await pollUntilSettled(app, '/api/pullrequests?repo=some-repo-id', cookie);
  assert.strictEqual(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.payload}`);
  assert.strictEqual(JSON.parse(res.payload).code, 'PAT_EXPIRED');
});

test('GET /api/pullrequests/repos: own identity, dead token -> 401 PAT_EXPIRED', async () => {
  const { app, cookieFor, dead } = await buildTestApp();
  dead.value = true;
  const cookie = cookieFor(SELF);

  const res = await pollUntilSettled(app, '/api/pullrequests/repos', cookie);
  assert.strictEqual(res.statusCode, 401, `expected 401, got ${res.statusCode}: ${res.payload}`);
  assert.strictEqual(JSON.parse(res.payload).code, 'PAT_EXPIRED');
});

// --- Convergence (Phase 7): the recorded self-sync error must be a
// transient signal, not a permanent latch, and it must only ever be
// attributed to the caller's OWN token — see server/index.js
// handleSelfSyncError and server/sync.js setClient.

test('GET /api/dashboard: once the scope\'s client is re-elected to a healthy one, a recovered person is no longer signed out', async () => {
  const { app, cookieFor, dead, scope } = await buildTestApp();
  dead.value = true;
  const cookie = cookieFor(SELF);

  const first = await pollUntilSettled(app, '/api/dashboard', cookie);
  assert.strictEqual(first.statusCode, 401, `expected the initial 401, got ${first.statusCode}: ${first.payload}`);
  assert.ok(scope.sync.selfSyncErrors.has(SELF.id), 'expected a recorded self-sync error after the 401');

  // The token has since been fixed (e.g. the person signed in again with a
  // fresh PAT) — server/scopes.js's getScope() re-election path reacts to
  // this by swapping in a new client via SyncEngine.setClient(), which is
  // the real trigger this test stands in for.
  dead.value = false;
  scope.sync.setClient(scope.sync.client);
  assert.ok(!scope.sync.selfSyncErrors.has(SELF.id), 'setClient must clear the stale self-sync error so recovery is possible');

  const recovered = await pollUntilSettled(app, '/api/dashboard', cookie);
  assert.notStrictEqual(recovered.statusCode, 401, `a recovered token must not still 401, got ${recovered.statusCode}: ${recovered.payload}`);
});

test('GET /api/dashboard: a dead SHARED (service) read token does not sign the caller out of their own session', async () => {
  const { app, cookieFor, dead, scope } = await buildTestApp();
  // Simulate the project's read token actually being the shared service
  // ADO_PAT (or a teammate's PAT that opened the project first) rather than
  // this caller's own — the scenario server/scopes.js electReadToken
  // produces whenever ADO_PAT can read the project. A dead token here is
  // NOT this caller's own token dying, so it must never produce the
  // personal "your access token has expired" sign-out.
  scope.readToken = { kind: 'service', pat: 'shared-service-pat' };
  dead.value = true;
  const cookie = cookieFor(SELF);

  const res = await pollUntilSettled(app, '/api/dashboard', cookie);
  assert.notStrictEqual(res.statusCode, 401, `a dead shared/service token must not 401 the caller's own session, got ${res.statusCode}: ${res.payload}`);
  assert.ok(!res.headers['set-cookie'], `a dead shared token must not clear the caller's session cookie, got: ${res.headers['set-cookie']}`);
});

test("scopes.js getScope: a scope whose SERVICE read token has died also re-elects on the next call (not gated to user-kind tokens only)", async () => {
  const { createScopeRegistry } = require('../server/scopes');
  const baseConfig = {
    org: 'test-org',
    pat: null,
    apiVersion: '7.1',
    port: 0,
    host: '127.0.0.1',
    cacheDir: path.join(tmpRoot('scopes-svc'), '.cache'),
    ownerEmail: '',
    rolesWikiPage: '/Dashboard Roles Test',
    dataDir: path.join(tmpRoot('scopes-svc-data'), 'data'),
    orgDataDir: path.join(tmpRoot('scopes-svc-org'), 'data', 'org'),
    maxProjectScopes: 8,
    prHistoryMonths: 12,
  };
  const registry = createScopeRegistry(baseConfig);
  const project = { id: 'eeeeeeee-3333-3333-3333-333333333333', name: 'ProjectE' };
  const scope = await registry.getScope(project, { pat: 'irrelevant', identity: SELF });

  // Force the scope into "dead service token" state: baseConfig.pat is null
  // in this fixture, so a real getScope() would never elect kind:'service'
  // on its own — mutated directly here to exercise the re-election guard
  // in isolation from electReadToken's own service-probe logic.
  scope.readToken = { kind: 'service', pat: 'stale-service-pat' };
  scope.sync.readTokenInvalid = true;
  scope.sync.selfSyncErrors.set(SELF.id, Object.assign(new Error('token revoked'), { status: 401 }));

  const again = await registry.getScope(project, { pat: 'callers-own-fresh-pat', identity: SELF });
  assert.strictEqual(again.readToken.kind, 'user', 'a dead SERVICE token must still be re-elected, not left stuck because it is not kind:user');
  assert.strictEqual(again.readToken.pat, 'callers-own-fresh-pat');
  assert.strictEqual(again.sync.readTokenInvalid, false, 'setClient must have reset readTokenInvalid on re-election');
  assert.ok(!again.sync.selfSyncErrors.has(SELF.id), 'setClient must have cleared the stale self-sync error on re-election');
});

module.exports = run;
