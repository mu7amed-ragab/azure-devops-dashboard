/**
 * Proves, in a separate process, that a whole demo session — sign-in, sync
 * of every project, every Scrum view, cross-project hours, search and pull
 * requests — makes no network connection of any kind, reads nothing from the
 * real .env/.cache/data folders, and writes nothing outside the temporary
 * folder. A separate process, because the test runner loads every suite into
 * one and an in-process check could be fooled by whatever loaded first.
 */

const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, run, assert } = require('./harness');

const DENY = path.join(__dirname, 'fixtures', 'denyIO.js');
const SCENARIO = path.join(__dirname, 'fixtures', 'demoScenario.js');

function child(args, env) {
  const res = spawnSync(process.execPath, args, {
    env: { ...process.env, NODE_ENV: 'production', ...env },
    encoding: 'utf8',
    timeout: 240000,
  });
  const lines = String(res.stdout || '').trim().split('\n');
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (err) {
    throw new Error(`child produced no result (exit ${res.status}): ${String(res.stderr || res.stdout).slice(-800)}`);
  }
}

suite('demo network and file isolation (child process)');

test('the guard itself intercepts a network call', () => {
  const res = spawnSync(
    process.execPath,
    ['-r', DENY, '-e', "try { require('https').get('https://example.invalid') } catch (e) {} process.stdout.write(String(global.__denyIO.networkAttempts))"],
    { encoding: 'utf8', env: { ...process.env, DENYIO_ALLOWED_ROOTS: os.tmpdir() } }
  );
  assert.strictEqual(res.stdout.trim(), '1');
});

test('a full demo session makes no network call and touches no real data', () => {
  const result = child(['-r', DENY, SCENARIO], { DEMO_MODE: '1', DENYIO_ALLOWED_ROOTS: os.tmpdir() });
  assert.ok(!result.error, result.error);
  assert.strictEqual(result.networkAttempts, 0, result.details.join('\n'));
  assert.strictEqual(result.fsViolations, 0, result.details.join('\n'));
  assert.strictEqual(result.realRequestCount, 0);
  assert.deepStrictEqual(result.unhandled, []);
  assert.deepStrictEqual(result.handlerErrors, []);
});

test('real mode loads no demo code at all', () => {
  const result = child([SCENARIO, '--real-mode-load-check'], { DEMO_MODE: '' });
  assert.ok(!result.error, result.error);
  assert.deepStrictEqual(result.demoModulesLoaded, []);
});

module.exports = run;
