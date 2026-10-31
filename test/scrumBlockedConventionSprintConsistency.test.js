/**
 * server/index.js's GET and PUT /api/scrum/blocked-convention must validate
 * tags against the SAME sprint. GET reads `?sprint=` (falling back to the
 * current sprint); PUT used to always validate against the current sprint
 * regardless of which sprint the editor was actually opened for — so a tag
 * GET offered from a non-current sprint 400'd on save. Exercised through the
 * real Fastify app (app.inject), same pattern as test/scrumHttpPermissions.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { buildApp } = require('../server/index');
const { createScopeRegistry } = require('../server/scopes');
const { CrossHours } = require('../server/crossHours');
const { deriveKey, seal } = require('../server/auth');
const { createFakeClient, workItem } = require('./fixtures/fakeClient');
const { AGILE } = require('./fixtures/processes');

/** Layers wiki page read/write onto a fakeClient's ADO answers — copied from
 * test/scrumHttpPermissions.test.js's own helper of the same shape, since
 * saving the blocked convention needs a wiki to persist to. */
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

const SESSION_COOKIE = 'azdash_session';
const PROJECT = { id: 'dddddddd-2222-2222-2222-222222222222', name: 'ProjectD' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-bc-sprint-${label}-`));
}

async function buildTestApp() {
  const root = tmpRoot('bc');
  const baseConfig = {
    org: 'test-org',
    pat: null,
    apiVersion: '7.1',
    port: 0,
    host: '127.0.0.1',
    cacheDir: path.join(root, '.cache'),
    webDist: path.join(root, 'web-dist'),
    ownerEmail: 'owner@test.org',
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

  const scope = await registry.getScope(PROJECT, { pat: 'irrelevant', identity: { id: 'seed', uniqueName: 'seed@test.org' } });
  const requirementType = AGILE.categories[0].workItemTypes[0].name; // 'User Story'
  const itemId = 900;
  const fakeClient = createFakeClient({
    project: PROJECT.name,
    process: AGILE,
    workItems: workItem({
      id: itemId,
      type: requirementType,
      state: 'Closed',
      teamProject: PROJECT.name,
      iterationPath: 'X\\Sprint 1',
      tags: 'legacy-tag',
    }),
  });
  scope.sync.setClient(withWiki(fakeClient, { pages: {} }));

  // Sprint 1 finished in the past; Sprint 2 spans today ("current"). The
  // tagged item's LATEST indexed iterationPath is Sprint 1 — the only sprint
  // whose own item set carries "legacy-tag".
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const inTwoWeeks = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  scope.sync.iterationMap = new Map([
    ['Sprint 1', { id: 1, name: 'Sprint 1', path: 'X\\Sprint 1', startDate: '2020-01-01', finishDate: '2020-01-14' }],
    ['Sprint 2', { id: 2, name: 'Sprint 2', path: 'X\\Sprint 2', startDate: yesterday, finishDate: inTwoWeeks }],
  ]);
  scope.sync.revisionIndex.set(itemId, [
    { rev: 1, changedDate: '2020-01-05', iterationPath: 'X\\Sprint 1', workItemType: requirementType, state: 'Closed' },
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

suite('GET/PUT /api/scrum/blocked-convention validate tags against the SAME sprint');

test('a tag GET offers for a non-current sprint is accepted by PUT for that same sprint', async () => {
  const { app, cookieFor } = await buildTestApp();
  const cookie = cookieFor({ id: 'owner', displayName: 'Owner', uniqueName: 'owner@test.org' });

  const getRes = await app.inject({
    method: 'GET',
    url: `/api/scrum/blocked-convention?sprint=${encodeURIComponent('X\\Sprint 1')}`,
    headers: { cookie },
  });
  assert.strictEqual(getRes.statusCode, 200, getRes.payload);
  const getBody = JSON.parse(getRes.payload);
  assert.ok(getBody.data.options.tags.includes('legacy-tag'), 'Sprint 1\'s own tag must be offered when editing against Sprint 1');

  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const putRes = await app.inject({
    method: 'PUT',
    url: `/api/scrum/blocked-convention?sprint=${encodeURIComponent('X\\Sprint 1')}`,
    headers: { cookie, 'content-type': 'application/json' },
    payload: { version: 1, byType: { [requirementType]: { states: [], tags: ['legacy-tag'], field: null } } },
  });
  assert.strictEqual(putRes.statusCode, 200, `saving the tag GET just offered for Sprint 1 must not 400, got ${putRes.statusCode}: ${putRes.payload}`);
});

test('the same tag is refused when saved against the CURRENT sprint, which never had it', async () => {
  const { app, cookieFor } = await buildTestApp();
  const cookie = cookieFor({ id: 'owner', displayName: 'Owner', uniqueName: 'owner@test.org' });

  const requirementType = AGILE.categories[0].workItemTypes[0].name;
  const putRes = await app.inject({
    method: 'PUT',
    url: '/api/scrum/blocked-convention', // no ?sprint= -> falls back to the current sprint (Sprint 2), which has no tags
    headers: { cookie, 'content-type': 'application/json' },
    payload: { version: 1, byType: { [requirementType]: { states: [], tags: ['legacy-tag'], field: null } } },
  });
  assert.strictEqual(putRes.statusCode, 400, 'a tag never seen in the sprint actually being validated against must still be refused');
});

module.exports = run;
