/**
 * A ~60-line test harness, on purpose.
 *
 * Node is hard-pinned to 16.x here (see package.json engines), which predates
 * `node:test` — that arrived in Node 18. Every third-party runner that does
 * support Node 16 (jest, mocha, vitest) is a dependency tree an order of
 * magnitude larger than the tests it would run, on a repo whose whole appeal is
 * that it self-hosts from two `npm install`s. So: `assert` plus this.
 *
 * Usage — see test/*.test.js:
 *
 *   const { suite, test, run } = require('./harness');
 *   suite('thing');
 *   test('does the thing', () => { assert.strictEqual(1, 1); });
 *   module.exports = run;   // the runner (tools/run-tests.js) awaits this
 */

const assert = require('assert');

let currentSuite = null;
const cases = [];

function suite(name) {
  currentSuite = name;
}

function test(name, fn) {
  cases.push({ suite: currentSuite, name, fn });
}

/** Runs every registered case, printing one line each. Async test functions are
 * awaited, so a case can drive a fake client that returns promises. */
async function run() {
  let passed = 0;
  const failures = [];
  let lastSuite = null;

  for (const c of cases) {
    if (c.suite !== lastSuite) {
      lastSuite = c.suite;
      console.log(`\n  ${c.suite}`);
    }
    try {
      await c.fn();
      passed += 1;
      console.log(`    ✓ ${c.name}`);
    } catch (err) {
      failures.push({ ...c, err });
      console.log(`    ✗ ${c.name}`);
      console.log(`        ${(err && err.message ? err.message : String(err)).split('\n').join('\n        ')}`);
    }
  }

  // Reset so one process can require several test files without their cases
  // bleeding into each other's run.
  cases.length = 0;
  return { passed, failures };
}

module.exports = { suite, test, run, assert };
