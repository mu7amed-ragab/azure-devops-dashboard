/**
 * T109 (quickstart.md Gate 5's two live permission-boundary checks),
 * exercised offline instead of against a live second ADO identity.
 *
 * quickstart.md's Gate 5 calls for two checks that need a second real ADO
 * account: a member with no team-wide role hitting a 403, and a subtree-
 * scoped team manager (role `lead`, not the project-wide dashboard owner)
 * hitting a 403 on the one write path (`PUT /api/scrum/blocked-convention`,
 * FR-035c-ii). Rather than duplicate `requireTeamPage`/`requireProjectAdmin`
 * (server/index.js) or `canSeeTeamPage`/`canAdminOrg` (server/org.js) in a
 * hand-rolled check, this suite drives the REAL Fastify app — the same
 * `buildApp` construction `server/index.js`'s `main()` uses in production —
 * through `app.inject()`, with a fake `AdoClient` (test/fixtures/fakeClient.js)
 * standing in for Azure DevOps and a thin wiki-page wrapper around it
 * standing in for the org chart. Every request below is a genuine HTTP call
 * against genuinely registered routes; nothing about the permission logic is
 * reimplemented here.
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
const PROJECT = { id: 'cccccccc-1111-1111-1111-111111111111', name: 'ProjectC' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-scrum-http-${label}-`));
}

/** Layers wiki page read/write onto a fakeClient's ADO answers — the same
 * shape test/scrumConvention.test.js's `fakeWikiClient` already proves
 * against the real server/orgStore.js, merged here with the ADO `/wit/`
 * endpoints `createFakeClient` answers, so one client can back both the org
 * chart AND the scrum data a route needs in the same request. */
function withWiki(client, { wikiExists = true, pages = {} } = {}) {
  return {
    ...client,
    async get(apiPath, options) {
      if (apiPath === '/wiki/wikis') return { value: wikiExists ? [{ name: `${client.project}.wiki` }] : [] };
      return client.get(apiPath, options);
    },
    async request(url, opts = {}) {
      const u = new URL(url);
      if (u.pathname.includes('/_apis/wiki/wikis/')) {
        const p = decodeURIComponent(u.searchParams.get('path'));
        if (opts.method === 'GET') {
          const page = pages[p];
          if (!page) {
            const err = new Error('not found');
            err.status = 404;
            throw err;
          }
          return { data: { content: page.content }, headers: { etag: page.etag }, status: 200 };
        }
        if (opts.method === 'PUT') {
          if (!wikiExists) {
            const err = new Error('not found');
            err.status = 404;
            throw err;
          }
          const existing = pages[p];
          const ifMatch = opts.headers && opts.headers['If-Match'];
          if (existing && ifMatch !== undefined && ifMatch !== existing.etag) {
            const err = new Error('conflict');
            err.status = 409;
            throw err;
          }
          const newEtag = `etag-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          pages[p] = { content: opts.body.content, etag: newEtag };
          return { headers: { etag: newEtag }, status: 200 };
        }
      }
      return client.request(url, opts);
    },
  };
}

/** A wiki page body in the exact fenced-JSON shape server/org.js's
 * renderOrgMarkdown produces and parseOrgMarkdown consumes. */
function orgChartPage(members) {
  const json = JSON.stringify({ version: 1, teams: [], members, blockedConvention: null });
  return { content: `# Dashboard Org Chart\n\n\`\`\`json\n${json}\n\`\`\`\n`, etag: 'etag0' };
}

/** Builds the real app (server/index.js's exported `buildApp` — identical to
 * what `main()` registers in production) wired to one pre-seeded, faked
 * scope for `PROJECT`, and returns a `cookieFor(identity)` helper that seals
 * a real session cookie the same way `POST /api/auth/project` would. The
 * scope is built and faked BEFORE any request, under the same scope key
 * (`registry`'s `scopeKey(project)`) the app's own `onRequest` hook will look
 * up — so the very first request already finds the faked client in place. */
async function buildTestApp({ ownerEmail = '', rolesWikiPage = '/Dashboard Roles Test', wiki } = {}) {
  const root = tmpRoot('perm');
  const baseConfig = {
    org: 'test-org',
    // No service PAT: electReadToken (server/scopes.js) then skips its
    // network probe entirely and every scope runs on the caller's own
    // (fake, here) token — no real ADO call is ever attempted.
    pat: null,
    apiVersion: '7.1',
    port: 0,
    host: '127.0.0.1',
    cacheDir: path.join(root, '.cache'),
    webDist: path.join(root, 'web-dist'),
    ownerEmail: ownerEmail.toLowerCase(),
    rolesWikiPage,
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

  const scope = await registry.getScope(PROJECT, { pat: 'irrelevant', identity: { id: 'seed', uniqueName: 'seed@test.org' } });
  const fakeClient = createFakeClient({ project: PROJECT.name, process: AGILE });
  scope.sync.setClient(wiki ? withWiki(fakeClient, wiki) : fakeClient);
  // A single sprint every read route can answer against without any network
  // call — ensureIterationMap (server/sync.js) short-circuits once this is
  // set, the same seeding pattern test/scrumScoping.test.js uses.
  scope.sync.iterationMap = new Map([
    ['Sprint 1', { id: 1, name: 'Sprint 1', path: 'Sprint 1', startDate: '2020-01-01', finishDate: '2020-01-14' }],
  ]);

  const sessionKey = deriveKey(baseConfig.sessionSecret);
  function cookieFor(identity) {
    const token = seal(
      { id: identity.id, displayName: identity.displayName, uniqueName: identity.uniqueName, iat: Date.now(), project: PROJECT, pat: 'irrelevant' },
      sessionKey
    );
    return `${SESSION_COOKIE}=${token}`;
  }

  return { app, cookieFor };
}

suite('Scrum HTTP permission boundaries (T109 / quickstart.md Gate 5, exercised through the real routes)');

test('a signed-in member with no team-wide role gets 403 from a team-wide /api/scrum route (FR-028)', async () => {
  // No wiki configured at all — createFakeClient's default `/wiki/wikis`
  // answer ({value: []}) leaves the org chart empty, so this identity
  // resolves to role: null, and isOwner is false (their email is not
  // ownerEmail below).
  const { app, cookieFor } = await buildTestApp({ ownerEmail: 'owner@test.org' });
  const res = await app.inject({
    method: 'GET',
    url: '/api/scrum/sprints',
    headers: { cookie: cookieFor({ id: 'u1', displayName: 'Dev', uniqueName: 'dev@test.org' }) },
  });
  assert.strictEqual(res.statusCode, 403, `expected 403, got ${res.statusCode}: ${res.payload}`);
  assert.strictEqual(JSON.parse(res.payload).code, 'VALIDATION');
});

test('a team manager (role "lead", subtree-scoped) reads the Scrum page but is refused the project-wide blocked-convention write (FR-035c-ii)', async () => {
  const pages = {
    '/Dashboard Roles Test': orgChartPage([{ id: 'm1', email: 'lead@test.org', displayName: 'Team Lead', role: 'lead', teamId: null, parentId: null }]),
  };
  const { app, cookieFor } = await buildTestApp({ ownerEmail: 'owner@test.org', wiki: { pages } });
  const cookie = cookieFor({ id: 'u2', displayName: 'Team Lead', uniqueName: 'lead@test.org' });

  // requireTeamPage (server/index.js): role "lead" carries the `teamPage`
  // capability (server/org.js ROLE_CAPABILITIES), so the read succeeds even
  // though this identity is not the project-wide owner.
  const readRes = await app.inject({ method: 'GET', url: '/api/scrum/sprints', headers: { cookie } });
  assert.strictEqual(readRes.statusCode, 200, `expected the lead's own team-wide read to succeed, got ${readRes.statusCode}: ${readRes.payload}`);

  // requireProjectAdmin (server/index.js) checks sync.isOwner ONLY — a lead's
  // canAdminOrg/adminOrg capability is deliberately not consulted here, since
  // it is subtree-scoped and the convention governs the whole project
  // (FR-035c-ii). This is the exact boundary quickstart.md's Gate 5 calls a
  // second identity out to prove.
  const writeRes = await app.inject({
    method: 'PUT',
    url: '/api/scrum/blocked-convention',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { version: 1, byType: {} },
  });
  assert.strictEqual(writeRes.statusCode, 403, `a subtree-scoped lead must not be able to change the project-wide convention, got ${writeRes.statusCode}: ${writeRes.payload}`);
  assert.strictEqual(JSON.parse(writeRes.payload).code, 'FORBIDDEN');
});

test('the dashboard owner succeeds at both the read and the project-wide blocked-convention write', async () => {
  const { app, cookieFor } = await buildTestApp({ ownerEmail: 'owner@test.org', wiki: { pages: {} } });
  const cookie = cookieFor({ id: 'u3', displayName: 'Owner', uniqueName: 'owner@test.org' });

  // canSeeTeamPage and requireProjectAdmin both short-circuit true for the
  // owner (server/org.js, server/index.js) regardless of any org-chart row —
  // the positive control the two 403 cases above are measured against.
  const readRes = await app.inject({ method: 'GET', url: '/api/scrum/sprints', headers: { cookie } });
  assert.strictEqual(readRes.statusCode, 200, `expected the owner's read to succeed, got ${readRes.statusCode}: ${readRes.payload}`);

  const writeRes = await app.inject({
    method: 'PUT',
    url: '/api/scrum/blocked-convention',
    headers: { cookie, 'content-type': 'application/json' },
    payload: { version: 1, byType: {} },
  });
  assert.strictEqual(writeRes.statusCode, 200, `expected the owner's convention write to succeed, got ${writeRes.statusCode}: ${writeRes.payload}`);
});

module.exports = run;
