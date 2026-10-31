/**
 * The per-screen check finds a real name wherever a screenshot could show
 * it, fails on anything it cannot read as text, and the navigation helpers
 * keep the capture on the demo app with the badge hidden.
 */

const { suite, test, run, assert } = require('./harness');
const { checkSnapshot } = require('../tools/capture/scan');
const { normalize, compact } = require('../tools/capture/normalize');
const { withPresentation, assertNotRealOrigin, isAllowedRequest, REAL_ORIGINS } = require('../tools/capture/navigate');

const TERMS = [
  { line: 3, value: 'Contrived Org' },
  { line: 7, value: 'وزارة المثال' },
].map((t) => ({ line: t.line, norm: normalize(t.value), compact: compact(t.value) }));

function clean() {
  return { title: 'Dashboard', text: 'Masar Customer Experience Portal', pseudoContent: [], fieldValues: ['checkout'], attributes: ['title=Demo data'], urls: ['/'], uninspectable: [], apiBodies: [{ url: '/api/dashboard', body: '{"org":"masar"}' }] };
}

suite('capture per-screen check');

test('a clean screen passes', () => {
  assert.deepStrictEqual(checkSnapshot(clean(), TERMS), { ok: true, leaks: [], uninspectable: [] });
});

test('a real name is found in every place a screen can show it, by deny-list line', () => {
  const cases = {
    title: (s) => (s.title = 'Contrived Org – Dashboard'),
    text: (s) => (s.text += ' CONTRIVED ORG'),
    'generated content': (s) => s.pseudoContent.push('"contrived org"'),
    'field value': (s) => s.fieldValues.push('Contrived Org'),
    attribute: (s) => s.attributes.push('aria-label=Contrived  Org'),
    url: (s) => s.urls.push('https://dev.azure.com/Contrived Org/x'),
    'api /api/team': (s) => s.apiBodies.push({ url: '/api/team', body: '{"name":"وَزارة المثال"}' }),
  };
  for (const [source, mutate] of Object.entries(cases)) {
    const s = clean();
    mutate(s);
    const r = checkSnapshot(s, TERMS);
    assert.strictEqual(r.ok, false, source);
    assert.ok(r.leaks.some((l) => l.source === source), `${source}: ${JSON.stringify(r.leaks)}`);
    for (const l of r.leaks) assert.ok(!('value' in l), 'a leak never carries the matched value');
  }
});

test('content that cannot be read as text fails the screen', () => {
  for (const tag of ['canvas', 'iframe', 'img']) {
    const s = clean();
    s.uninspectable.push({ tag, reason: 'x' });
    assert.strictEqual(checkSnapshot(s, TERMS).ok, false, tag);
  }
});

test('every navigation carries presentation=1, and only the demo origin is allowed', () => {
  assert.strictEqual(new URL(withPresentation('http://127.0.0.1:5180/team?x=1')).searchParams.get('presentation'), '1');
  assert.strictEqual(new URL(withPresentation('http://127.0.0.1:5180/?presentation=0')).searchParams.get('presentation'), '1');
  for (const origin of REAL_ORIGINS) assert.throws(() => assertNotRealOrigin(`${origin}/`), /real app/);
  assert.doesNotThrow(() => assertNotRealOrigin('http://127.0.0.1:5180'));
  assert.ok(isAllowedRequest('http://127.0.0.1:5180/api/dashboard', 'http://127.0.0.1:5180'));
  assert.ok(isAllowedRequest('data:image/png;base64,AA', 'http://127.0.0.1:5180'));
  assert.ok(!isAllowedRequest('https://dev.azure.com/masar/_apis', 'http://127.0.0.1:5180'));
  assert.ok(!isAllowedRequest('https://fonts.googleapis.com/css', 'http://127.0.0.1:5180'));
});

module.exports = run;
