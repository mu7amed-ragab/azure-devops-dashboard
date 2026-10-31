/**
 * server/ado/revisionIndex.js — the bulk revision-history reader every
 * Scrum view (velocity/progress/utilisation/burndown/impediments/scope-
 * change) and the per-person hours timeline read through. Covers: the v3
 * field shape (remainingWork/state/iterationPath/estimate/workItemType,
 * docs/invariants.md's REVISION_INDEX_VERSION bump), changedBy parsing, paging via
 * continuation token with a tracked watermark, and same-rev overwrite
 * rather than duplication.
 */

const { suite, test, run, assert } = require('./harness');
const { fetchRevisionsSince, changedByKey, REVISION_INDEX_VERSION, BASE_REVISION_FIELDS } = require('../server/ado/revisionIndex');

/** A minimal stand-in for AdoClient — just enough of `.get()` to drive
 * fetchRevisionsSince's paging loop, scripted page by page. */
function fakeReportingClient(pages) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async get(apiPath, options) {
      calls.push({ apiPath, query: options && options.query });
      const page = pages[i] || { values: [], isLastBatch: true };
      i += 1;
      return page;
    },
  };
}

function rev(id, overrides = {}) {
  return {
    id,
    rev: 1,
    fields: {
      'System.ChangedDate': '2025-06-01T00:00:00Z',
      'System.ChangedBy': 'Alice <alice@x.com>',
      'Microsoft.VSTS.Scheduling.CompletedWork': 2,
      'Microsoft.VSTS.Scheduling.RemainingWork': 6,
      'System.State': 'Active',
      'System.IterationPath': 'Proj\\Sprint 1',
      'System.WorkItemType': 'Task',
      'System.Parent': 100,
      ...overrides,
    },
  };
}

suite('revisionIndex: changedByKey (v2, docs/invariants.md hours-attribution fix)');

test('extracts and lowercases the email from the legacy display-name format', () => {
  assert.strictEqual(changedByKey('Alice Smith <Alice@X.COM>'), 'alice@x.com');
});

test('a bare value with no angle brackets is used as-is, lowercased', () => {
  assert.strictEqual(changedByKey('someone@x.com'), 'someone@x.com');
});

test('null/empty/non-string input yields null rather than throwing', () => {
  assert.strictEqual(changedByKey(null), null);
  assert.strictEqual(changedByKey(''), null);
  assert.strictEqual(changedByKey(undefined), null);
});

suite('revisionIndex: v3 entry shape (remainingWork/state/iterationPath/estimate/workItemType/parentId)');

test('every v3 field is parsed onto the entry, typed (numbers as numbers, dates/strings as strings)', async () => {
  const client = fakeReportingClient([{ values: [rev(1)], isLastBatch: true }]);
  const index = new Map();
  await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, 'Microsoft.VSTS.Scheduling.StoryPoints');
  const entry = index.get(1)[0];
  assert.strictEqual(entry.completedWork, 2);
  assert.strictEqual(entry.remainingWork, 6);
  assert.strictEqual(entry.state, 'Active');
  assert.strictEqual(entry.iterationPath, 'Proj\\Sprint 1');
  assert.strictEqual(entry.workItemType, 'Task');
  assert.strictEqual(entry.parentId, 100);
  assert.strictEqual(entry.changedBy, 'alice@x.com');
});

test('a field absent from the feed response is null, never undefined — v2/v3 distinguishability depends on this', async () => {
  const page = { values: [rev(1, { 'Microsoft.VSTS.Scheduling.RemainingWork': undefined })], isLastBatch: true };
  const client = fakeReportingClient([page]);
  const index = new Map();
  await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, null);
  const entry = index.get(1)[0];
  assert.strictEqual(entry.remainingWork, null);
  assert.ok('remainingWork' in entry, 'the key itself must exist — "in" distinguishes v3-absent from a v2 entry with no key at all');
});

test('with no estimateField, `estimate` is always null and the field is never requested', async () => {
  const client = fakeReportingClient([{ values: [rev(1)], isLastBatch: true }]);
  const index = new Map();
  await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, null);
  assert.strictEqual(index.get(1)[0].estimate, null);
  const requestedFields = client.calls[0].query.fields.split(',');
  assert.ok(!requestedFields.some((f) => f.includes('StoryPoints')), 'no estimate field requested when the project has none');
});

test('with an estimateField, its value is read into `estimate` and appended to the requested field list', async () => {
  const client = fakeReportingClient([
    { values: [rev(1, { 'Microsoft.VSTS.Scheduling.StoryPoints': 5 })], isLastBatch: true },
  ]);
  const index = new Map();
  await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, 'Microsoft.VSTS.Scheduling.StoryPoints');
  assert.strictEqual(index.get(1)[0].estimate, 5);
  assert.ok(client.calls[0].query.fields.split(',').includes('Microsoft.VSTS.Scheduling.StoryPoints'));
});

test('the base field list carries every v3 field the docs describe, unconditionally', () => {
  for (const f of [
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'System.State',
    'System.IterationPath',
    'System.WorkItemType',
  ]) {
    assert.ok(BASE_REVISION_FIELDS.includes(f), `${f} missing from BASE_REVISION_FIELDS`);
  }
});

test('REVISION_INDEX_VERSION is bumped to 3, forcing old-shaped caches to be discarded rather than misread', () => {
  assert.strictEqual(REVISION_INDEX_VERSION, 3);
});

suite('revisionIndex: paging (continuation token, watermark)');

test('pages until isLastBatch, following the continuation token', async () => {
  const client = fakeReportingClient([
    { values: [rev(1, { 'System.ChangedDate': '2025-06-01T00:00:00Z' })], isLastBatch: false, continuationToken: 'tok1' },
    { values: [rev(2, { 'System.ChangedDate': '2025-06-02T00:00:00Z' })], isLastBatch: true },
  ]);
  const index = new Map();
  const { watermark, pages } = await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, null);
  assert.strictEqual(pages, 2);
  assert.strictEqual(index.size, 2);
  // Second page's request must carry the continuation token, not a fresh startDateTime.
  assert.strictEqual(client.calls[1].query.continuationToken, 'tok1');
  assert.strictEqual(watermark, '2025-06-02T00:00:00Z');
});

test('the watermark is the max ChangedDate seen, not the last page\'s', async () => {
  const client = fakeReportingClient([
    { values: [rev(1, { 'System.ChangedDate': '2025-06-05T00:00:00Z' })], isLastBatch: false, continuationToken: 'tok1' },
    { values: [rev(2, { 'System.ChangedDate': '2025-06-02T00:00:00Z' })], isLastBatch: true },
  ]);
  const index = new Map();
  const { watermark } = await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, null);
  assert.strictEqual(watermark, '2025-06-05T00:00:00Z');
});

test('a page with no token but isLastBatch false stops rather than looping forever', async () => {
  const client = fakeReportingClient([{ values: [rev(1)], isLastBatch: false }]);
  const index = new Map();
  const { pages } = await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, null);
  assert.strictEqual(pages, 1);
});

test('the SAME work item\'s revisions, split across two continuation pages with different rev values, merge into one correctly-sorted history — not two separate entries or a last-page-wins overwrite', async () => {
  const client = fakeReportingClient([
    // Page 1: this item's rev 1 and rev 3 (a real reporting-feed page can
    // return an item's revisions out of arrival order relative to others).
    {
      values: [
        rev(1, { 'System.ChangedDate': '2025-06-01T00:00:00Z', 'Microsoft.VSTS.Scheduling.RemainingWork': 10 }),
        { ...rev(1, { 'System.ChangedDate': '2025-06-10T00:00:00Z', 'Microsoft.VSTS.Scheduling.RemainingWork': 4 }), rev: 3 },
      ],
      isLastBatch: false,
      continuationToken: 'tok1',
    },
    // Page 2 (a later continuation page): the SAME item's rev 2, arriving
    // after page 1 already created its array in the index.
    {
      values: [{ ...rev(1, { 'System.ChangedDate': '2025-06-05T00:00:00Z', 'Microsoft.VSTS.Scheduling.RemainingWork': 7 }), rev: 2 }],
      isLastBatch: true,
    },
  ]);
  const index = new Map();
  await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, null);
  const history = index.get(1);
  assert.strictEqual(history.length, 3, 'all three revisions across both pages must be present — none dropped, none merged into one');
  assert.deepStrictEqual(history.map((e) => e.rev), [1, 2, 3], 'sorted by rev even though rev 2 arrived on the later page');
  assert.deepStrictEqual(history.map((e) => e.remainingWork), [10, 7, 4]);
});

suite('revisionIndex: same-revision entries overwrite rather than duplicate');

test('the same id+rev arriving twice (a resumed/re-walked page) replaces the entry, not append', async () => {
  const client = fakeReportingClient([
    { values: [rev(1, { 'Microsoft.VSTS.Scheduling.CompletedWork': 2 })], isLastBatch: false, continuationToken: 'tok1' },
    { values: [rev(1, { 'Microsoft.VSTS.Scheduling.CompletedWork': 4 })], isLastBatch: true },
  ]);
  const index = new Map();
  await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, null);
  assert.strictEqual(index.get(1).length, 1);
  assert.strictEqual(index.get(1)[0].completedWork, 4);
});

test('entries end up sorted by rev ascending regardless of arrival order', async () => {
  const client = fakeReportingClient([
    {
      values: [
        { ...rev(1), rev: 3 },
        { ...rev(1), rev: 1 },
        { ...rev(1), rev: 2 },
      ],
      isLastBatch: true,
    },
  ]);
  const index = new Map();
  await fetchRevisionsSince(client, '2025-01-01T00:00:00Z', index, null, null);
  assert.deepStrictEqual(index.get(1).map((e) => e.rev), [1, 2, 3]);
});

module.exports = run;
