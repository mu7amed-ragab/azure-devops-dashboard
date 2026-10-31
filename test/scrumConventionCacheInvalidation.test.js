/**
 * server/scrum.js's ScrumEngine.invalidateConventionDependentCaches(),
 * wired into PUT /api/scrum/blocked-convention (server/index.js) right after
 * a successful save. Before this, `scrum-items-*` and `scrum-impediments-*`
 * — both keyed per sprint and short-TTL'd because they read current ADO
 * values — kept answering from their pre-save cache entries for up to
 * SHORT_TTL_MS after a convention change, so the standup view showed "no
 * convention set" / stale matches right after configuring it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { Cache } = require('../server/cache');
const { ScrumEngine } = require('../server/scrum');

function tmpRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `azdash-conv-cache-${label}-`));
}

suite('ScrumEngine.invalidateConventionDependentCaches()');

test('clears every scrum-items-* and scrum-impediments-* entry, leaving unrelated keys alone', () => {
  const cache = new Cache(tmpRoot('clear'));
  cache.set('scrum-items-X%5CSprint%201', { at: Date.now(), items: ['stale'] });
  cache.set('scrum-items-X%5CSprint%202', { at: Date.now(), items: ['stale'] });
  cache.set('scrum-impediments-X%5CSprint%201', { at: Date.now(), value: { items: ['stale'] } });
  cache.set('scrum-velocity-X%5CSprint%201', { total: 5 }); // unrelated — must survive
  cache.set('revisionIndex', { entries: [] }); // unrelated — must survive

  const scrum = new ScrumEngine({}, cache, {});
  scrum.invalidateConventionDependentCaches();

  assert.strictEqual(cache.get('scrum-items-X%5CSprint%201'), undefined);
  assert.strictEqual(cache.get('scrum-items-X%5CSprint%202'), undefined);
  assert.strictEqual(cache.get('scrum-impediments-X%5CSprint%201'), undefined);
  assert.ok(cache.get('scrum-velocity-X%5CSprint%201'), 'velocity cache is unrelated to the convention and must not be cleared');
  assert.ok(cache.get('revisionIndex'), 'the revision index is unrelated and must not be cleared');
});

test('a cache with nothing to clear is a no-op, not an error', () => {
  const cache = new Cache(tmpRoot('empty'));
  const scrum = new ScrumEngine({}, cache, {});
  scrum.invalidateConventionDependentCaches(); // must not throw
  assert.deepStrictEqual(cache.keys(), []);
});

suite('Cache.delete()');

test('removes a key from both memory and disk; deleting an absent key is a no-op', () => {
  const dir = tmpRoot('delete');
  const cache = new Cache(dir);
  cache.set('k', { v: 1 });
  assert.ok(fs.existsSync(path.join(dir, 'k.json')));
  cache.delete('k');
  assert.strictEqual(cache.get('k'), undefined);
  assert.strictEqual(fs.existsSync(path.join(dir, 'k.json')), false);
  cache.delete('never-existed'); // must not throw
});

module.exports = run;
