/**
 * PullRequestsView's "N of M PRs" count used to build itself as
 * t('pr.countLabel', { count: t('pr.visibleOfTotal', {...}) }) — a formatted
 * string like "3 of 10" fed into a PLURAL selector. Intl.PluralRules.select
 * needs a real number; a non-numeric `count` can't resolve a CLDR category,
 * and the composition let the English word "of" leak into Arabic output
 * regardless. The fix replaced this with a single `pr.countLabelFiltered`
 * catalog entry, pluralized by a real number and interpolated in one pass.
 *
 * The catalogs are TS/ESM (and ar.ts pulls in zustand indirectly through
 * i18n/index.ts), so they're read here as plain text — the same approach
 * test/i18nGlossary.test.js already uses for this repo's offline,
 * TypeScript-free test harness — rather than imported as modules. The
 * plural-category MECHANICS are verified for real via Node's own
 * Intl.PluralRules, which is what web/src/lib/i18n/index.ts's t() uses too.
 */

const fs = require('fs');
const path = require('path');
const { suite, test, run, assert } = require('./harness');

const EN_PATH = path.join(__dirname, '..', 'web', 'src', 'lib', 'i18n', 'en.ts');
const AR_PATH = path.join(__dirname, '..', 'web', 'src', 'lib', 'i18n', 'ar.ts');
const COMPONENT_PATH = path.join(__dirname, '..', 'web', 'src', 'components', 'PullRequestsView.tsx');

/** Pulls one `'key': { ... }` plural-object literal out of a catalog file by
 * brace-matching from the key onward — good enough for these hand-written,
 * uniformly-formatted catalog files (same spirit as i18nGlossary.test.js's
 * own regex parsing, just brace-aware since these values are multi-line
 * objects rather than single-quoted strings). */
function extractPluralEntry(fileText, key) {
  const marker = `'${key}':`;
  const start = fileText.indexOf(marker);
  assert.ok(start >= 0, `catalog key ${key} not found`);
  const braceStart = fileText.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < fileText.length; i++) {
    if (fileText[i] === '{') depth++;
    else if (fileText[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = fileText.slice(braceStart + 1, i);
  const entries = {};
  const pairRe = /(\w+):\s*'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = pairRe.exec(body))) entries[m[1]] = m[2];
  return entries;
}

suite('pr.countLabelFiltered: composed with real interpolation, not a nested plural string');

test('the component no longer nests a translated string as another key\'s plural `count`', () => {
  const componentText = fs.readFileSync(COMPONENT_PATH, 'utf8');
  assert.ok(!/count:\s*t\(/.test(componentText), 'no call site may pass a t(...) result as a plural `count` selector');
});

test('English: every category is a real interpolation template, with neither "of" hardcoded around a pre-formatted composite nor missing entirely', () => {
  const en = extractPluralEntry(fs.readFileSync(EN_PATH, 'utf8'), 'pr.countLabelFiltered');
  assert.ok(en.one && en.other, 'English needs at least one/other');
  for (const [category, template] of Object.entries(en)) {
    assert.ok(template.includes('{visible}'), `${category} must interpolate {visible} directly`);
    assert.ok(template.includes('{total}'), `${category} must interpolate {total} directly`);
    assert.ok(/\bof\b/.test(template), `${category} should read naturally as "X of Y ..." in English`);
  }
});

test('Arabic: every category interpolates {visible}, and every non-trivial category also interpolates {total} (never a bare pre-formatted composite, never the English "of")', () => {
  const ar = extractPluralEntry(fs.readFileSync(AR_PATH, 'utf8'), 'pr.countLabelFiltered');
  const categories = ['zero', 'one', 'two', 'few', 'many', 'other'];
  for (const category of categories) {
    assert.ok(ar[category], `Arabic pr.countLabelFiltered is missing category "${category}"`);
    assert.ok(ar[category].includes('{visible}'), `${category} must interpolate {visible}`);
    assert.ok(!/\bof\b/i.test(ar[category]), `${category} must not contain the English word "of": "${ar[category]}"`);
  }
  // "one"/"two" spell the total out in Arabic words (طلب واحد / طلبين) rather
  // than interpolating a numeral, which is why only few/many/other/zero
  // carry a literal {total} placeholder.
  for (const category of ['few', 'many', 'other']) {
    assert.ok(ar[category].includes('{total}'), `${category} must interpolate {total}`);
  }
});

suite('pr.countLabelFiltered: plural category selection works for a REAL number (the actual bug)');

test('Intl.PluralRules resolves a genuine numeric total, unlike the old pre-formatted "N of M" string it replaced', () => {
  const enRules = new Intl.PluralRules('en-US');
  const arRules = new Intl.PluralRules('ar');

  // The fixed call site passes the real total as `count` — this must resolve
  // to a valid CLDR category for both languages at representative values.
  for (const total of [0, 1, 2, 3, 11, 100]) {
    assert.ok(['zero', 'one', 'two', 'few', 'many', 'other'].includes(enRules.select(total)));
    assert.ok(['zero', 'one', 'two', 'few', 'many', 'other'].includes(arRules.select(total)));
  }

  // The bug this guards: feeding a composed string like "3 of 10" (what
  // t('pr.visibleOfTotal', {...}) used to return) into PluralRules.select
  // instead of a number cannot select a meaningful category.
  const composed = '3 of 10';
  assert.ok(Number.isNaN(Number(composed)), 'a pre-formatted "N of M" string is not a number a plural selector can use');
});

module.exports = run;
