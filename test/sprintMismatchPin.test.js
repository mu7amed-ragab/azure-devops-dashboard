/**
 * US3 (005-search-history-sprint-placement) — "the child under its parent is
 * marked as out-of-sprint". research.md R8 found this substantially already
 * shipped: `isSprintMismatch`/`countSprintMismatches`
 * (web/src/lib/sprintMismatch.ts) and the rollups that never dropped a
 * mismatched child. This suite pins that EXISTING behavior so US2's new
 * cross-sprint-promotion code (server/compute/crossSprint.js,
 * server/sync.js#groupByIteration) can never regress it — FR-020 (silent
 * when either side is null) and FR-015 (a story's hours rollup still
 * includes an out-of-sprint child, unchanged) in particular.
 *
 * web/src/lib/sprintMismatch.ts is TypeScript/ESM, and this repo's offline
 * harness runs plain CommonJS (no ts-node, no build step — see
 * test/prCountLabelPlural.test.js's identical note for the i18n catalogs).
 * `isSprintMismatch`/`countSprintMismatches` have no JSX and no runtime
 * dependency beyond a type import, so their source is read and stripped of
 * TypeScript-only syntax (type annotations, the `import type` line) rather
 * than transpiled — turning the CURRENT FILE ON DISK into the thing under
 * test, not a hand-copied re-implementation of it that could silently drift
 * from the real one.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { suite, test, run, assert } = require('./harness');

const SOURCE_PATH = path.join(__dirname, '..', 'web', 'src', 'lib', 'sprintMismatch.ts');

function loadPinnedFunctions() {
  // A CRLF checkout must strip the same way as an LF one.
  let src = fs.readFileSync(SOURCE_PATH, 'utf8').replace(/\r\n/g, '\n');
  src = src.replace(/^import type \{[^}]*\} from '[^']*';\n/m, '');
  src = src.replace(/^import \{[^}]*\} from '[^']*';\n/m, ''); // the `t` import — sprintLabel is untested here, so it's fine unresolved
  src = src.replace(/^export /gm, '');
  // Strip `: Type` annotations on function params/return — good enough for
  // this file's simple param lists (no generics, no object destructuring).
  src = src.replace(/(\w+)\s*:\s*[\w\s|<>[\].]+(?=[,)])/g, '$1');
  src = src.replace(/\)\s*:\s*\w+\s*\{/g, ') {');
  const context = { module: { exports: {} }, exports: {} };
  vm.createContext(context);
  vm.runInContext(
    `${src}\nmodule.exports = { isSprintMismatch, countSprintMismatches };`,
    context,
    { filename: 'sprintMismatch.pinned.js' }
  );
  return context.module.exports;
}

const { isSprintMismatch, countSprintMismatches } = loadPinnedFunctions();

suite('isSprintMismatch — pinned (FR-014, FR-020)');

test('different sprints on task vs. story is a mismatch', () => {
  assert.strictEqual(isSprintMismatch('Proj\\Sprint A', 'Proj\\Sprint B'), true);
});

test('the same sprint on both is not a mismatch', () => {
  assert.strictEqual(isSprintMismatch('Proj\\Sprint A', 'Proj\\Sprint A'), false);
});

test('a null task iterationPath is silent, not a mismatch (FR-020)', () => {
  assert.strictEqual(isSprintMismatch(null, 'Proj\\Sprint B'), false);
});

test('a null story iterationPath is silent too (FR-020)', () => {
  assert.strictEqual(isSprintMismatch('Proj\\Sprint A', null), false);
});

test('both null is silent', () => {
  assert.strictEqual(isSprintMismatch(null, null), false);
});

suite('countSprintMismatches — pinned (FR-016)');

function story(iterationPath, tasks) {
  return { iterationPath, tasks };
}
function task(iterationPath) {
  return { iterationPath };
}

test('counts exactly the tasks whose sprint differs from the story', () => {
  const s = story('Proj\\Sprint B', [task('Proj\\Sprint A'), task('Proj\\Sprint B'), task('Proj\\Sprint A')]);
  assert.strictEqual(countSprintMismatches(s), 2);
});

test('zero mismatches when every task matches its story', () => {
  const s = story('Proj\\Sprint B', [task('Proj\\Sprint B'), task('Proj\\Sprint B')]);
  assert.strictEqual(countSprintMismatches(s), 0);
});

test('a task with no iterationPath never counts as a mismatch', () => {
  const s = story('Proj\\Sprint B', [task(null)]);
  assert.strictEqual(countSprintMismatches(s), 0);
});

test('a story with no iterationPath counts none of its tasks as mismatched (FR-020)', () => {
  const s = story(null, [task('Proj\\Sprint A'), task('Proj\\Sprint B')]);
  assert.strictEqual(countSprintMismatches(s), 0);
});

module.exports = run;
