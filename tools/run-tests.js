#!/usr/bin/env node
/**
 * Test runner — `npm test`.
 *
 * Requires every test/*.test.js in turn and awaits the `run` each exports (see
 * test/harness.js for why this isn't `node:test` or jest). Exits non-zero on the
 * first failing suite's failures, printing a per-file and overall tally.
 *
 * Everything under test/ is offline: no ADO calls, no cookies, no ports. Fake
 * clients stand in for Azure DevOps and real Cache instances write into
 * os.tmpdir(). Nothing in here can touch production data, which is the point —
 * the isolation properties these tests assert are exactly the ones you don't
 * want to discover by mutating a live project.
 */

const fs = require('fs');
const path = require('path');

const TEST_DIR = path.join(__dirname, '..', 'test');

async function main() {
  const files = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

  if (files.length === 0) {
    console.error('No test files found in test/.');
    process.exit(1);
  }

  let totalPassed = 0;
  const allFailures = [];

  for (const file of files) {
    console.log(`\n${file}`);
    const run = require(path.join(TEST_DIR, file));
    if (typeof run !== 'function') {
      throw new Error(`${file} must \`module.exports = run\` (see test/harness.js)`);
    }
    const { passed, failures } = await run();
    totalPassed += passed;
    allFailures.push(...failures.map((f) => ({ ...f, file })));
  }

  console.log(`\n${'-'.repeat(60)}`);
  if (allFailures.length === 0) {
    console.log(`${totalPassed} passed, 0 failed`);
    return;
  }
  console.log(`${totalPassed} passed, ${allFailures.length} FAILED`);
  for (const f of allFailures) {
    console.log(`  ${f.file} › ${f.suite} › ${f.name}`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
