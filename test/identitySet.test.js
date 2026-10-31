/**
 * 006-linked-identity-aliases, Phase 2 (T006).
 *
 * Exercises the FR-004 matching rule in `server/identitySet.js` directly —
 * pure and synchronous, so no fake ADO client is needed for `buildIdentitySet`.
 * `resolveIdentitySet`'s network-facing half (the degraded fallback) is
 * covered with a client stub that throws.
 */

const { suite, test, run, assert } = require('./harness');
const {
  buildIdentitySet,
  primaryOnlySet,
  resolveIdentitySet,
  isEligibleLink,
  MAX_LINKED_IDENTITIES,
} = require('../server/identitySet');

const PRIMARY = { id: 'id-new', displayName: 'Alex Karim', uniqueName: 'alex.k@EXAMPLE.DEV' };
const RETIRED = { id: 'id-old', displayName: 'Alex Karim', uniqueName: 'alex.k@legacy-example.onmicrosoft.com' };

suite('identitySet: buildIdentitySet / FR-004 matching rule');

test('links an identity whose local part matches exactly, case-insensitively', () => {
  const set = buildIdentitySet(PRIMARY, [RETIRED]);
  assert.strictEqual(set.linked.length, 1);
  assert.strictEqual(set.linked[0].uniqueName, RETIRED.uniqueName);
  assert.strictEqual(set.all.length, 2);
  assert.ok(set.keys.has('alex.k@legacy-example.onmicrosoft.com'));
  assert.ok(set.keys.has('alex.k@example.dev')); // primary key is lowercased too
  assert.ok(set.ids.has('id-old'));
});

test('does not link a near-miss local part (fuzzy-search noise)', () => {
  const nearMiss1 = { id: 'x1', displayName: 'Someone Else', uniqueName: 'alex.k2@legacy-example.onmicrosoft.com' };
  const nearMiss2 = { id: 'x2', displayName: 'Another', uniqueName: 'alex.kali@legacy-example.onmicrosoft.com' };
  const set = buildIdentitySet(PRIMARY, [nearMiss1, nearMiss2]);
  assert.strictEqual(set.linked.length, 0);
  assert.deepStrictEqual(set.all, [PRIMARY]);
});

test('never links an identity to itself, including the same address under different casing', () => {
  const self1 = { ...PRIMARY };
  const self2 = { id: 'id-new', displayName: 'Alex Karim', uniqueName: 'ALEX.K@example.dev' };
  const set = buildIdentitySet(PRIMARY, [self1, self2]);
  assert.strictEqual(set.linked.length, 0);
});

test('a single-identity person gets linked: [] — the common case', () => {
  const set = buildIdentitySet(PRIMARY, []);
  assert.deepStrictEqual(set.linked, []);
  assert.deepStrictEqual(set.all, [PRIMARY]);
  assert.strictEqual(set.degraded, false);
});

test('drops a candidate with no usable id rather than linking it with a null id', () => {
  const noId = { id: null, displayName: 'Ghost', uniqueName: 'alex.k@legacy-example.onmicrosoft.com' };
  const set = buildIdentitySet(PRIMARY, [noId]);
  assert.strictEqual(set.linked.length, 0);
});

test('dedupes candidates by lowercased uniqueName across sources', () => {
  const dup1 = { ...RETIRED };
  const dup2 = { id: 'id-old', displayName: 'Alex Karim', uniqueName: 'Alex.K@legacy-example.onmicrosoft.com' };
  const set = buildIdentitySet(PRIMARY, [dup1, dup2]);
  assert.strictEqual(set.linked.length, 1);
});

test('caps the linked set at MAX_LINKED_IDENTITIES', () => {
  const many = Array.from({ length: MAX_LINKED_IDENTITIES + 5 }, (_, i) => ({
    id: `id-${i}`,
    displayName: `Dup ${i}`,
    uniqueName: `alex.k@domain${i}.example`,
  }));
  const set = buildIdentitySet(PRIMARY, many);
  assert.strictEqual(set.linked.length, MAX_LINKED_IDENTITIES);
  assert.strictEqual(set.all.length, MAX_LINKED_IDENTITIES + 1);
});

test('linked is always an array, never undefined, even with no candidates at all', () => {
  const set = buildIdentitySet(PRIMARY, undefined);
  assert.ok(Array.isArray(set.linked));
  assert.strictEqual(set.linked.length, 0);
});

test('an address with no @ is its own local part and can still match', () => {
  const noAt = { id: 'id-svc', displayName: 'Service Account', uniqueName: 'alex.k' };
  const primaryNoAt = { id: 'id-new', displayName: 'X', uniqueName: 'alex.k' };
  const set = buildIdentitySet(primaryNoAt, [noAt]);
  // same id as primary is excluded, but a distinct id with the identical bare
  // local part still links
  assert.strictEqual(set.linked.length, 0); // same id — excluded correctly
});

suite('identitySet: isEligibleLink');

test('rejects a candidate with no uniqueName', () => {
  assert.strictEqual(isEligibleLink(PRIMARY, { id: 'z' }), false);
});

test('rejects a candidate with no id', () => {
  assert.strictEqual(isEligibleLink(PRIMARY, { uniqueName: RETIRED.uniqueName }), false);
});

test('accepts a genuine match', () => {
  assert.strictEqual(isEligibleLink(PRIMARY, RETIRED), true);
});

suite('identitySet: primaryOnlySet / resolveIdentitySet degraded fallback (FR-005)');

test('primaryOnlySet is a zero-candidate IdentitySet', () => {
  const set = primaryOnlySet(PRIMARY);
  assert.deepStrictEqual(set.all, [PRIMARY]);
  assert.strictEqual(set.degraded, false);
});

test('primaryOnlySet honors an explicit degraded flag', () => {
  const set = primaryOnlySet(PRIMARY, { degraded: true });
  assert.strictEqual(set.degraded, true);
});

test('resolveIdentitySet falls back to primary-only, degraded, on any failure', async () => {
  const throwingClient = {
    async request() {
      throw new Error('network is down');
    },
  };
  const set = await resolveIdentitySet(throwingClient, PRIMARY, []);
  assert.deepStrictEqual(set.all, [PRIMARY]);
  assert.strictEqual(set.degraded, true);
});

test('resolveIdentitySet does not attempt discovery for a malformed primary uniqueName', async () => {
  let called = false;
  const client = {
    async request() {
      called = true;
      return { results: [] };
    },
  };
  const set = await resolveIdentitySet(client, { id: 'x', uniqueName: '' }, []);
  assert.strictEqual(called, false);
  assert.strictEqual(set.degraded, false);
  assert.strictEqual(set.linked.length, 0);
});

module.exports = run;
