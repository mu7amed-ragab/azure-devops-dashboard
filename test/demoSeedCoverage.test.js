/**
 * The fictional organization is generated, not hand-written, so its richness
 * is asserted: every minimum and every situation a view exists for, on more
 * than one date (the data is relative to today), deterministically, and with
 * nothing in it that points outside the fictional organization.
 */

const { suite, test, run, assert } = require('./harness');
const { createDemoOrg } = require('../server/demo');
const { coverageReport } = require('../server/demo/seed/coverage');

const SEED = 20261029;

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object' && !(value instanceof Date)) Object.values(value).forEach((v) => strings(v, out));
  return out;
}

function snapshot(state) {
  return JSON.stringify({ items: [...state.workItems.values()], prs: state.pullRequests, capacity: state.capacity, wikis: state.wikis });
}

suite('demo seed coverage');

for (const when of ['2026-10-29T09:00:00', '2027-03-02T09:00:00', '2026-11-07T23:30:00']) {
  test(`covers every feature when today is ${when}`, () => {
    const state = createDemoOrg({ seed: SEED, now: new Date(when) });
    const { ok, missing } = coverageReport(state);
    assert.ok(ok, `missing: ${missing.join('; ')}`);
  });
}

test('the same seed and date always produce the same organization', () => {
  const now = new Date('2026-10-29T09:00:00');
  assert.strictEqual(snapshot(createDemoOrg({ seed: SEED, now })), snapshot(createDemoOrg({ seed: SEED, now })));
});

test('nothing in the organization points outside it', () => {
  const state = createDemoOrg({ seed: SEED, now: new Date('2026-10-29T09:00:00') });
  const all = strings({ people: state.people, projects: state.projects.map((p) => ({ ...p, process: undefined })), items: [...state.workItems.values()], prs: state.pullRequests, wikis: state.wikis });
  for (const s of all) {
    for (const m of s.matchAll(/dev\.azure\.com\/([^/\s"]+)/g)) assert.strictEqual(m[1], 'masar', s);
    for (const m of s.matchAll(/[A-Za-z0-9._-]+@([A-Za-z0-9.-]+)/g)) assert.ok(['masar.dev', 'masar-legacy.dev'].includes(m[1]), s);
  }
});

module.exports = run;
