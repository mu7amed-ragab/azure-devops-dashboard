/**
 * Pure, offline consistency check over the i18n glossary and the Arabic
 * catalog (T073/T074, SC-004) — no browser, no TypeScript compiler, no new
 * dependency. `web/src/lib/i18n/glossary.ts` and `ar.ts` are read as plain
 * text and parsed with a regex tailored to their known, hand-written
 * structure (both files are simple object-literal tables — see their own
 * headers) rather than requiring a TS toolchain in the server-side test
 * harness.
 *
 * What this checks mechanically (SC-004's "zero synonym collisions"):
 *   1. Every glossary concept has a non-empty Arabic term.
 *   2. No two DIFFERENT glossary concepts share the same Arabic term, except
 *      pairs the glossary itself documents as deliberately synonymous
 *      (sprint/iteration — see glossary.ts's own note).
 *   3. Every glossary term actually appears somewhere in ar.ts — a term
 *      nobody uses is dead weight, not evidence of consistency.
 *   4. No ar.ts value is an empty string (belt-and-braces on top of the
 *      Record<keyof typeof en, ...> type gate — this catches an empty
 *      string, which is a valid value of that type and NOT caught by tsc).
 *   5. A small dialect-marker scan (T074) flagging common non-MSA
 *      colloquialisms, so a dialectal string is caught mechanically rather
 *      than only in human review (FR-023).
 *
 * What this can NOT check (and doesn't pretend to): whether a catalog
 * string uses a DIFFERENT Arabic word for the same underlying concept the
 * glossary names (e.g. a synonym the glossary never anticipated). That is
 * exactly why T076's human register review still exists — this test is the
 * mechanical floor, not a substitute for reading the Arabic.
 */

const fs = require('fs');
const path = require('path');
const { suite, test, run, assert } = require('./harness');

const GLOSSARY_PATH = path.join(__dirname, '..', 'web', 'src', 'lib', 'i18n', 'glossary.ts');
const AR_PATH = path.join(__dirname, '..', 'web', 'src', 'lib', 'i18n', 'ar.ts');

function readGlossary() {
  const text = fs.readFileSync(GLOSSARY_PATH, 'utf8');
  const entryRe = /concept:\s*'([^']+)',\s*en:\s*'([^']+)',\s*ar:\s*'([^']+)',\s*convention:\s*'([^']+)',\s*note:\s*'([^']*)',/g;
  const entries = [];
  let m;
  while ((m = entryRe.exec(text))) {
    entries.push({ concept: m[1], en: m[2], ar: m[3], convention: m[4], note: m[5] });
  }
  return entries;
}

/** Every single-quoted string literal in ar.ts — catalog keys (ASCII,
 * dotted identifiers like 'workitems.count') and Arabic values both come
 * out of this; callers filter by content. Handles escaped quotes/backslashes
 * inside a literal (ar.ts uses none today, but the parser doesn't assume that). */
function readArStrings() {
  const text = fs.readFileSync(AR_PATH, 'utf8');
  const stringRe = /'((?:[^'\\]|\\.)*)'/g;
  const strings = [];
  let m;
  while ((m = stringRe.exec(text))) {
    strings.push(m[1]);
  }
  return strings;
}

const ARABIC_RE = /[؀-ۿ]/;

// Pairs the glossary itself documents as deliberately sharing one Arabic
// term — see glossary.ts's own notes ("Same as sprint in this context").
const ALLOWED_SYNONYM_PAIRS = new Set(['sprint|iteration', 'iteration|sprint']);

/** A minimal Arabic affix stripper — not a real stemmer, just enough to stop
 * "is this glossary term used anywhere?" from failing on ordinary plural/
 * definite-article inflection (e.g. "العقبة" singular vs "العقبات" plural in
 * a heading). Strips a leading "ال" (definite article) and one trailing
 * plural/gender suffix, leaving a root fragment that's still specific
 * (Arabic roots are typically 3+ letters) but tolerant of inflection. */
function stem(word) {
  let w = word;
  if (w.startsWith('ال') && w.length > 4) w = w.slice(2);
  const suffixes = ['ات', 'ون', 'ين', 'ان', 'ة'];
  for (const suf of suffixes) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      w = w.slice(0, -suf.length);
      break;
    }
  }
  return w;
}

/** True if every significant word (stem length >= 2) making up `term`
 * has its stem present somewhere in the corpus — tolerant of inflection,
 * still specific enough to catch a genuinely unused term. */
function termUsedIn(term, corpusText) {
  const words = term.split(/\s+/).filter(Boolean);
  const significant = words.map(stem).filter((s) => s.length >= 2);
  if (significant.length === 0) return corpusText.includes(term);
  return significant.every((s) => corpusText.includes(s));
}

// A short, deliberately conservative blocklist of common Gulf/Levantine/
// Egyptian colloquialisms that have no place in Modern Standard Arabic UI
// copy (FR-023) — not exhaustive, just enough to catch an obvious slip
// mechanically rather than relying solely on the T076 human read. Matched as
// whole words (space/punctuation-delimited), not bare substrings — Arabic
// words routinely contain these letter sequences internally (e.g. "وين"
// inside "عضوين", "يلا" inside "تحليلات") without being the colloquial word.
const DIALECT_MARKERS = ['شو', 'ليش', 'وين', 'هيك', 'مش', 'عشان', 'كده', 'بتاع', 'اهو', 'يلا'];

/** Tokenizes on whitespace and common punctuation, so a marker must appear
 * as its own word to count — not merely as a substring of a longer one. */
function wordsOf(text) {
  return text.split(/[\s.,؛،!؟?()«»"'—–:/\\-]+/).filter(Boolean);
}

suite('i18n glossary consistency (SC-004)');

test('every glossary concept has a non-empty Arabic term', () => {
  const glossary = readGlossary();
  assert(glossary.length > 0, 'glossary must not be empty');
  for (const entry of glossary) {
    assert(entry.ar && entry.ar.trim().length > 0, `glossary concept "${entry.concept}" has an empty Arabic term`);
  }
});

test('no two different concepts collide on the same Arabic term (except documented pairs)', () => {
  const glossary = readGlossary();
  const byTerm = new Map();
  for (const entry of glossary) {
    if (!byTerm.has(entry.ar)) byTerm.set(entry.ar, []);
    byTerm.get(entry.ar).push(entry.concept);
  }
  const collisions = [];
  for (const [term, concepts] of byTerm) {
    if (concepts.length <= 1) continue;
    for (let i = 0; i < concepts.length; i++) {
      for (let j = i + 1; j < concepts.length; j++) {
        const key = `${concepts[i]}|${concepts[j]}`;
        if (!ALLOWED_SYNONYM_PAIRS.has(key)) {
          collisions.push(`"${term}" used for both "${concepts[i]}" and "${concepts[j]}"`);
        }
      }
    }
  }
  assert.strictEqual(collisions.length, 0, `undocumented term collisions: ${collisions.join('; ')}`);
});

test('every glossary term is actually used somewhere in ar.ts (inflection-tolerant)', () => {
  const glossary = readGlossary();
  const arStrings = readArStrings();
  const arText = arStrings.join('\n');
  const orphaned = glossary.filter((entry) => !termUsedIn(entry.ar, arText));
  assert.strictEqual(
    orphaned.length,
    0,
    `glossary terms never used in ar.ts: ${orphaned.map((e) => `${e.concept} ("${e.ar}")`).join(', ')}`
  );
});

test('no empty-string values in ar.ts', () => {
  const text = fs.readFileSync(AR_PATH, 'utf8');
  // Matches `'key': '',` — an empty value satisfies the TS Record<string, string>
  // type gate but is never a real translation.
  const emptyValueRe = /'[a-zA-Z0-9_.]+':\s*'',/g;
  const matches = text.match(emptyValueRe) || [];
  assert.strictEqual(matches.length, 0, `empty-string catalog values found: ${matches.join(', ')}`);
});

test('no dialectal markers in ar.ts values (FR-023 register check)', () => {
  const arStrings = readArStrings().filter((s) => ARABIC_RE.test(s));
  const markerSet = new Set(DIALECT_MARKERS);
  const offenders = [];
  for (const s of arStrings) {
    for (const word of wordsOf(s)) {
      if (markerSet.has(word)) {
        offenders.push(`"${word}" in "${s}"`);
      }
    }
  }
  assert.strictEqual(offenders.length, 0, `possible dialectal forms found: ${offenders.join('; ')}`);
});

test('glossary parses to the expected count (sanity check on the regex itself)', () => {
  const glossary = readGlossary();
  // 23 concepts per data-model.md §4 — if this drifts, either a concept was
  // added/removed (update this number) or the parser silently stopped
  // matching entries (a real bug this test exists to catch).
  assert.strictEqual(glossary.length, 23, `expected 23 glossary concepts, parsed ${glossary.length}`);
});

module.exports = run;
