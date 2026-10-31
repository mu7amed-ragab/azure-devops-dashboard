/**
 * The screenshot capture refuses to run without a usable list of real names:
 * missing, unreadable, too short, no Arabic entry, or not covering the real
 * organization, default project and every project opened on this machine.
 * Refusals name what is missing and never echo a value.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { loadDenyList } = require('../tools/capture/denylist');
const { normalize, compact } = require('../tools/capture/normalize');

const ORG = 'Contrived Org';
const PROJECT = 'Alpha Beta';
const SECRETISH = [ORG, PROJECT, 'gamma-delta'];

function setup({ terms, env = `ADO_ORG=contrived-org\nADO_PROJECT=${PROJECT}\n`, cacheDirs = ['alpha-beta-0a1b2c3d', 'gamma-delta-11223344', '_org'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azdash-deny-'));
  const serviceDir = path.join(root, 'service');
  fs.mkdirSync(path.join(serviceDir, '.cache'), { recursive: true });
  if (env !== null) fs.writeFileSync(path.join(serviceDir, '.env'), env);
  for (const d of cacheDirs) fs.mkdirSync(path.join(serviceDir, '.cache', d));
  const file = path.join(root, 'denylist.txt');
  if (terms !== null) fs.writeFileSync(file, terms.join('\n'));
  return { root, serviceDir, file };
}

const GOOD = ['# real names', ORG, PROJECT, 'Gamma Delta', 'وزارة المثال', 'someone@example.org', 'Repo One', 'Repo Two', 'Person A', 'Person B', 'example.org'];

function refusal(opts, category) {
  const { root, ...rest } = opts;
  try {
    assert.throws(
      () => loadDenyList(rest),
      (err) => {
        assert.ok(err.category && err.category.startsWith(category), `expected ${category}, got ${err.category}: ${err.message}`);
        for (const v of SECRETISH) assert.ok(!err.message.toLowerCase().includes(v.toLowerCase()), `message leaks "${v}"`);
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

suite('capture deny list');

test('a complete list is accepted', () => {
  const s = setup({ terms: GOOD });
  try {
    const { terms } = loadDenyList({ file: s.file, serviceDir: s.serviceDir });
    assert.strictEqual(terms.length, GOOD.length - 1);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test('missing and unreadable lists are refused', () => {
  refusal(setup({ terms: null }), 'missing');
  const s = setup({ terms: null });
  fs.mkdirSync(s.file);
  refusal(s, 'unreadable');
});

test('a short list, or one with no Arabic term, is refused', () => {
  refusal(setup({ terms: GOOD.slice(0, 9) }), 'too-short');
  refusal(setup({ terms: GOOD.filter((t) => !/[؀-ۿ]/.test(t)).concat(['Filler One']) }), 'no-arabic');
});

test('the real organization, default project and every opened project must be covered', () => {
  refusal(setup({ terms: GOOD.filter((t) => t !== ORG).concat(['Filler']) }), 'not-covered:organization name');
  refusal(setup({ terms: GOOD.filter((t) => t !== PROJECT).concat(['Filler']) }), 'not-covered:default project name');
  refusal(setup({ terms: GOOD.filter((t) => t !== 'Gamma Delta').concat(['Filler']) }), 'not-covered:real project #2');
});

test('an unreadable service configuration or an unusable required name is refused', () => {
  refusal(setup({ terms: GOOD, env: null }), 'unreadable-source');
  refusal(setup({ terms: GOOD, env: 'ADO_PROJECT=Alpha Beta\n' }), 'required-name-unusable:organization name');
});

test('matching ignores case, Arabic spelling variants and separators', () => {
  assert.strictEqual(normalize('وَزارة'), normalize('وزاره'));
  assert.strictEqual(normalize('أحمد'), normalize('احمد'));
  assert.strictEqual(normalize('MiXeD‏ Case'), 'mixed case');
  assert.ok(compact('Alpha Beta').includes(compact('alpha-beta')));
});

module.exports = run;
