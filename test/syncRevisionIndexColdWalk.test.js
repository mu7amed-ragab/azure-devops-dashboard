/**
 * SyncEngine-level regression for `ensureRevisionIndex()` — the end-to-end
 * cold-walk path (estimate-field discovery -> paged fetch -> v3 index build
 * -> disk persistence), as opposed to test/revisionIndex.test.js, which
 * exercises the lower-level `fetchRevisionsSince` in isolation. This is the
 * "real cold walk" that `test/scrumVelocity.test.js`'s own buildEngine
 * helper comment says is THIS file's job, not its own — that file seeds
 * `engine.revisionIndex` directly instead of paging through it.
 *
 * Drives a real `SyncEngine` + real disk `Cache` against the shared
 * `test/fixtures/fakeClient.js`'s scriptable `revisionPages` mechanism
 * (built for exactly this purpose — see the original design notes
 * tasks.md T004).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { Cache } = require('../server/cache');
const { SyncEngine } = require('../server/sync');
const { buildScopeConfig } = require('../server/scopes');
const { createFakeClient } = require('./fixtures/fakeClient');
const { AGILE } = require('./fixtures/processes');
const { REVISION_INDEX_VERSION } = require('../server/ado/revisionIndex');

const PROJECT = { id: 'p1', name: 'ProjectX' };

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-coldwalk-${label}-`));
}

function baseConfigIn(root) {
  return {
    org: 'test-org',
    pat: 'service-pat',
    apiVersion: '7.1',
    cacheDir: path.join(root, '.cache'),
    dataDir: path.join(root, 'data'),
    orgDataDir: path.join(root, 'data', 'org'),
    defaultProject: null,
    ownerEmail: null,
    rolesWikiPage: '/Dashboard Roles Test',
    syncIntervalMs: 900000,
    prHistoryMonths: 12,
    maxProjectScopes: 8,
  };
}

function rawEntry(id, rev, overrides = {}) {
  return {
    id,
    rev,
    fields: {
      'System.ChangedDate': '2025-06-01T00:00:00Z',
      'System.ChangedBy': 'Alice <alice@x.com>',
      'Microsoft.VSTS.Scheduling.CompletedWork': 1,
      'Microsoft.VSTS.Scheduling.RemainingWork': 9,
      'System.State': 'Active',
      'System.IterationPath': 'X\\Sprint 1',
      'System.WorkItemType': 'User Story',
      'System.Parent': null,
      'Microsoft.VSTS.Scheduling.StoryPoints': 5,
      ...overrides,
    },
  };
}

suite('SyncEngine.ensureRevisionIndex(): the real cold walk (estimate-field discovery -> paged fetch -> v3 index -> disk persistence)');

test('builds a correct v3 index from a multi-page cold walk, advances the watermark, and persists it to disk', async () => {
  const root = tmpRoot('build');
  const base = baseConfigIn(root);
  const config = buildScopeConfig(base, PROJECT, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache, cache);

  const client = createFakeClient({
    project: PROJECT.name,
    process: AGILE,
    revisionPages: [
      {
        values: [
          rawEntry(1, 1, { 'System.ChangedDate': '2025-06-01T08:00:00Z' }),
          rawEntry(2, 1, { 'System.ChangedDate': '2025-06-01T09:00:00Z', 'System.WorkItemType': 'Task' }),
        ],
        isLastBatch: false,
        continuationToken: 'tok1',
      },
      {
        values: [rawEntry(1, 2, { 'System.ChangedDate': '2025-06-03T00:00:00Z', 'Microsoft.VSTS.Scheduling.RemainingWork': 3 })],
        isLastBatch: true,
      },
    ],
  });
  engine.setClient(client);

  const pages = await engine.ensureRevisionIndex();

  // The walk itself: two pages, both items indexed, v3 fields present.
  assert.strictEqual(pages, 2);
  assert.strictEqual(engine.revisionIndex.size, 2);
  const item1 = engine.revisionIndex.get(1);
  assert.strictEqual(item1.length, 2);
  assert.deepStrictEqual(item1.map((e) => e.rev), [1, 2]);
  assert.strictEqual(item1[0].remainingWork, 9);
  assert.strictEqual(item1[1].remainingWork, 3, 'the second page\'s revision is merged in, not dropped');
  assert.strictEqual(item1[0].estimate, 5, 'the discovered estimate field (StoryPoints, from the AGILE fixture) is read into the entry');
  assert.strictEqual(item1[0].workItemType, 'User Story');
  const item2 = engine.revisionIndex.get(2);
  assert.strictEqual(item2[0].workItemType, 'Task');

  // The watermark: max ChangedDate across both pages, not the last page's.
  assert.strictEqual(engine.revisionWatermark, '2025-06-03T00:00:00Z');

  // Persistence: what actually landed on disk (read back through a FRESH
  // Cache instance, not the in-memory one this engine already holds).
  const rehydratedCache = new Cache(config.cacheDir);
  const persisted = rehydratedCache.get('revisionIndex');
  assert.ok(persisted, 'the index must be written to disk, not just held in memory');
  assert.strictEqual(persisted.version, REVISION_INDEX_VERSION);
  assert.strictEqual(persisted.watermark, '2025-06-03T00:00:00Z');
  assert.strictEqual(persisted.entries.length, 2);
  assert.strictEqual(persisted.pages, null, 'a 2-page walk is below INDEX_ESTIMATE_MIN_PAGES, so no page estimate is persisted');
});

test('a restart resumes from the persisted watermark: the hydrated index survives a fresh walk rather than being discarded and rebuilt', async () => {
  const root = tmpRoot('resume');
  const base = baseConfigIn(root);
  const config = buildScopeConfig(base, PROJECT, { readTokenIsService: true });

  // "Session 1": a cold walk that finds one item, then persists to disk.
  const cache1 = new Cache(config.cacheDir);
  const engine1 = new SyncEngine({ ...config, pat: 'service-pat' }, cache1, cache1);
  const client1 = createFakeClient({
    project: PROJECT.name,
    process: AGILE,
    revisionPages: [{ values: [rawEntry(1, 1, { 'System.ChangedDate': '2025-06-01T00:00:00Z' })], isLastBatch: true }],
  });
  engine1.setClient(client1);
  await engine1.ensureRevisionIndex();
  assert.strictEqual(engine1.revisionIndex.size, 1);

  // "Restart": a brand-new SyncEngine + brand-new Cache instance pointed at
  // the SAME directory — nothing in-process is shared with engine1/cache1.
  const cache2 = new Cache(config.cacheDir);
  const engine2 = new SyncEngine({ ...config, pat: 'service-pat' }, cache2, cache2);

  // Construction alone must have hydrated the persisted index — before any
  // network call happens at all.
  assert.strictEqual(engine2.revisionIndex.size, 1, 'the persisted index is loaded into memory on construction');
  assert.strictEqual(engine2.revisionIndex.get(1)[0].rev, 1);
  assert.strictEqual(engine2.revisionWatermark, '2025-06-01T00:00:00Z', 'the persisted watermark is restored, not reset to INDEX_START_DATE');

  // This session's own walk returns only a NEW item (id 2) — nothing about
  // id 1. If ensureRevisionIndex() discarded the hydrated index and started
  // from an empty Map, id 1 would be gone afterward; if it genuinely
  // resumes (appends onto what construction already loaded), id 1 survives
  // alongside the newly-walked id 2.
  const client2 = createFakeClient({
    project: PROJECT.name,
    process: AGILE,
    revisionPages: [{ values: [rawEntry(2, 1, { 'System.ChangedDate': '2025-06-10T00:00:00Z', 'System.WorkItemType': 'Task' })], isLastBatch: true }],
  });
  engine2.setClient(client2);
  await engine2.ensureRevisionIndex();

  assert.strictEqual(engine2.revisionIndex.size, 2, 'both the resumed-from-disk item and the newly-walked item are present');
  assert.ok(engine2.revisionIndex.has(1), 'the item from before the "restart" was not dropped');
  assert.ok(engine2.revisionIndex.has(2), 'the item from this session\'s own walk is present');
  assert.strictEqual(engine2.revisionWatermark, '2025-06-10T00:00:00Z', 'the watermark advances past the resumed one');
});

test('a transient estimate-field discovery failure rejects the whole pass instead of baking estimate:null into the index and advancing the watermark', async () => {
  const root = tmpRoot('estimate-failure');
  const base = baseConfigIn(root);
  const config = buildScopeConfig(base, PROJECT, { readTokenIsService: true });
  const cache = new Cache(config.cacheDir);
  const engine = new SyncEngine({ ...config, pat: 'service-pat' }, cache, cache);

  const realClient = createFakeClient({
    project: PROJECT.name,
    process: AGILE,
    revisionPages: [{ values: [rawEntry(1, 1)], isLastBatch: true }],
  });
  // Every requirement type's field-list request fails — simulates a
  // transient network error during estimate-field discovery, distinct from
  // a project that genuinely has no estimate field.
  const flakyClient = {
    ...realClient,
    async get(apiPath, options) {
      if (/^\/wit\/workitemtypes\/[^/]+$/.test(apiPath)) {
        throw Object.assign(new Error('service unavailable'), { status: 503 });
      }
      return realClient.get(apiPath, options);
    },
  };
  engine.setClient(flakyClient);

  await assert.rejects(engine.ensureRevisionIndex());

  // Nothing from the failed pass landed: no poisoned estimate:null entries,
  // and the watermark did not advance past data that was never indexed.
  assert.strictEqual(engine.revisionIndex.size, 0);
  assert.strictEqual(engine.cache.get('revisionIndex'), undefined, 'a failed pass must not persist anything to disk');

  // A retry against a healthy client recovers cleanly — this failure mode is
  // transient, not a permanent poisoning of the shared index.
  engine.setClient(realClient);
  const pages = await engine.ensureRevisionIndex();
  assert.strictEqual(pages, 1);
  assert.strictEqual(engine.revisionIndex.get(1)[0].estimate, 5, 'the retry correctly discovers the estimate field this time');
});

module.exports = run;
