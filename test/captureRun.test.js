/**
 * Screenshot output is published only by a fully passing run, and replaces
 * the previous set as a whole: a failed run leaves it untouched, a partial
 * run never touches it, and nothing from one run survives into the next.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { startRun, shotPath, failRun, promoteRun } = require('../tools/capture/run');

function tree(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    out[entry.name] = entry.isDirectory() ? tree(p) : fs.readFileSync(p, 'utf8');
  }
  return out;
}

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azdash-shots-'));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

suite('capture output');

test('a successful run replaces the published set wholesale', () => {
  withRoot((root) => {
    const first = startRun(root);
    fs.writeFileSync(shotPath(first, 'en', 'light', 1, 'old-only'), 'png');
    promoteRun(first);
    const second = startRun(root);
    fs.writeFileSync(shotPath(second, 'en', 'light', 1, 'dashboard'), 'png');
    promoteRun(second);
    const latest = tree(path.join(root, 'latest'));
    assert.ok(latest['en-light']['01-dashboard.png']);
    assert.ok(!latest['en-light']['01-old-only.png'], 'nothing from the earlier run survives');
    assert.ok(latest['index.html'].includes('01-dashboard.png'));
    assert.ok(!latest['index.html'].includes('old-only'));
    assert.strictEqual(fs.readdirSync(root).filter((n) => n.startsWith('.staging-')).length, 0);
  });
});

test('a failed run leaves the published set byte-identical and removes its own output', () => {
  withRoot((root) => {
    const first = startRun(root);
    fs.writeFileSync(shotPath(first, 'ar', 'dark', 1, 'team'), 'png');
    promoteRun(first);
    const before = JSON.stringify(tree(path.join(root, 'latest')));
    const failing = startRun(root);
    fs.writeFileSync(shotPath(failing, 'ar', 'dark', 1, 'team'), 'leaky');
    failRun(failing, { shot: 'team', lang: 'ar', theme: 'dark', source: 'text', line: 4 });
    assert.strictEqual(JSON.stringify(tree(path.join(root, 'latest'))), before);
    assert.ok(!fs.existsSync(failing.dir));
    const failure = JSON.parse(fs.readFileSync(path.join(root, 'last-failure.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(failure).sort(), ['at', 'lang', 'line', 'shot', 'source', 'theme']);
  });
});

test('a partial run never touches the published set', () => {
  withRoot((root) => {
    const full = startRun(root);
    fs.writeFileSync(shotPath(full, 'en', 'dark', 1, 'scrum'), 'png');
    promoteRun(full);
    const before = JSON.stringify(tree(path.join(root, 'latest')));
    const partial = startRun(root);
    fs.writeFileSync(shotPath(partial, 'en', 'dark', 1, 'team'), 'png');
    promoteRun(partial, { partial: true });
    assert.strictEqual(JSON.stringify(tree(path.join(root, 'latest'))), before);
    assert.ok(tree(path.join(root, 'partial'))['en-dark']['01-team.png']);
  });
});

module.exports = run;
