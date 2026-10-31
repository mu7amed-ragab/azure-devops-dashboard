// CommonJS on purpose: Playwright is resolved from a machine-local install
// via NODE_PATH, which Node honors for require() but not for ESM import.
//
// Captures the demo screenshot set for a portfolio: every shot in
// tools/demo-shots.json, in English and Arabic, light and dark. Fail-closed:
// before each screenshot the screen's text, form values, title, addresses,
// labels and the data it received are checked against a list of real names
// kept outside the repository; anything that can't be read as text fails the
// shot. Any failure, or any error while checking, aborts the whole run and
// publishes nothing.
//
// Usage (from the demo worktree, with `npm run demo` running there):
//   $env:NODE_PATH = "<path-to>/browser-tools/node_modules"
//   node tools/capture-demo.cjs [--only id,id] [--lang en|ar] [--theme light|dark]
//
// See server/demo/README.md for the full recipe.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { loadDenyList } = require('./capture/denylist');
const { collectSnapshot, checkSnapshot } = require('./capture/scan');
const { withPresentation, assertNotRealOrigin, isAllowedRequest } = require('./capture/navigate');
const { startRun, shotPath, failRun, promoteRun } = require('./capture/run');

const BASE_URL = (process.env.CAPTURE_BASE_URL || 'http://127.0.0.1:5180').replace(/\/$/, '');
const OUT_ROOT = path.join(__dirname, '..', '.demo', 'shots');
const SHOTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-shots.json'), 'utf8')).shots;
const TOKENS = { lead: 'demo-lead', member: 'demo-member' };
const VIEWPORT = { width: 1440, height: 900 };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

class CaptureFailure extends Error {
  constructor(info) {
    super(info.reason);
    this.info = info;
  }
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`${url} answered ${res.statusCode}`));
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

async function preflight(denyTerms) {
  assertNotRealOrigin(BASE_URL);
  let me;
  try {
    me = await getJson(`${BASE_URL}/api/auth/me`);
  } catch (err) {
    throw new Error(`Refusing to capture: ${BASE_URL} is not reachable (${err.message}).`);
  }
  if (me.demo !== true) throw new Error(`Refusing to capture: the app at ${BASE_URL} is not in demo mode.`);
  await getJson(`${BASE_URL}/api/demo/status`);
  return denyTerms;
}

/** Signs in through the API, once per role, keeping the cookies at each
 * step so the login screens can be shot without signing in again (the
 * password step is rate-limited). */
async function signInStates(browser) {
  const states = {};
  for (const [role, token] of Object.entries(TOKENS)) {
    const context = await browser.newContext();
    const post = async (url, data) => {
      const res = await context.request.post(BASE_URL + url, { data });
      if (!res.ok()) throw new Error(`${url} answered ${res.status()}`);
    };
    await post('/api/auth/password', { password: 'demo' });
    if (role === 'lead') states.gate = await context.storageState();
    await post('/api/auth/pat', { pat: token });
    if (role === 'lead') states['no-project'] = await context.storageState();
    await post('/api/auth/project', { project: 'Customer Experience Portal' });
    states[role] = await context.storageState();
    await context.close();
  }
  states['signed-out'] = undefined;
  return states;
}

async function waitSettled(page, selector) {
  if (selector) await page.waitForSelector(selector, { state: 'visible', timeout: 45000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(
    () => document.querySelectorAll('[aria-busy="true"], .animate-spin').length === 0,
    null,
    { timeout: 60000 }
  );
}

async function runShot({ page, shot, variant, n, run, terms, bodies, project, gen }) {
  const where = { shot: shot.id, lang: variant.lang, theme: variant.theme };
  if (shot.project && project.current !== shot.project) {
    const res = await page.context().request.post(`${BASE_URL}/api/auth/project`, { data: { project: shot.project } });
    if (!res.ok()) throw new CaptureFailure({ ...where, reason: `could not switch to the shot's project (${res.status()})` });
    project.current = shot.project;
  }
  bodies.length = 0;
  await page.goto(withPresentation(BASE_URL + shot.route), { waitUntil: 'load', timeout: 30000 });
  await waitSettled(page, shot.waitFor);
  for (const action of shot.actions || []) {
    if (action.click) await page.click(action.click);
    if (action.type) await page.fill(action.type, action.value);
    if (action.waitFor) await page.waitForSelector(action.waitFor, { state: 'visible', timeout: 30000 });
    if (action.press) await page.keyboard.press(action.press);
    if (action.waitCount) {
      const [selector, count] = action.waitCount;
      await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length >= n, [selector, count], { timeout: 60000 });
    }
    await waitSettled(page, null);
  }

  if ((await page.locator('[data-demo-badge]').count()) > 0) {
    throw new CaptureFailure({ ...where, reason: 'the demo badge is visible' });
  }
  const snapshot = await page.evaluate(collectSnapshot);
  snapshot.apiBodies = (await Promise.all(bodies.map((b) => b))).filter((b) => b.gen === gen.n);
  if (snapshot.apiBodies.some((b) => b.error)) {
    throw new CaptureFailure({ ...where, reason: 'a response could not be read, so it could not be checked', source: snapshot.apiBodies.find((b) => b.error).url });
  }
  const result = checkSnapshot(snapshot, terms);
  if (!result.ok) {
    if (result.uninspectable.length > 0) {
      throw new CaptureFailure({ ...where, reason: 'content that cannot be checked as text', detail: result.uninspectable });
    }
    throw new CaptureFailure({ ...where, reason: 'a deny-listed name is on screen', leaks: result.leaks });
  }
  await page.screenshot({ path: shotPath(run, variant.lang, variant.theme, n, shot.id), fullPage: Boolean(shot.fullPage) });
  console.log(`  ✓ ${variant.lang}-${variant.theme} ${String(n).padStart(2, '0')} ${shot.id}`);
}

async function main() {
  const only = arg('only') ? arg('only').split(',') : null;
  const langs = arg('lang') ? [arg('lang')] : ['en', 'ar'];
  const themes = arg('theme') ? [arg('theme')] : ['light', 'dark'];
  const partial = Boolean(only || arg('lang') || arg('theme'));
  const shots = SHOTS.filter((s) => !only || only.includes(s.id));

  let terms;
  try {
    terms = (await preflight(loadDenyList().terms)) || [];
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }

  const started = Date.now();
  const run = startRun(OUT_ROOT);
  const browser = await chromium.launch();
  let failure = null;
  const at = {};
  try {
    const states = await signInStates(browser);
    for (const lang of langs) {
      for (const theme of themes) {
        const variant = { lang, theme };
        const byState = new Map();
        for (const shot of shots) {
          const key = shot.as || shot.stage;
          if (!byState.has(key)) byState.set(key, []);
          byState.get(key).push(shot);
        }
        for (const [key, group] of byState) {
          const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, storageState: states[key] });
          await context.addInitScript(({ t, l }) => {
            window.localStorage.setItem('theme', t);
            window.localStorage.setItem('lang', l);
          }, { t: theme, l: lang });
          const page = await context.newPage();
          const bodies = [];
          const gen = { n: 0 };
          const requestedIn = new WeakMap();
          // Responses are tagged with the document that requested them (the
          // generation advances when a navigation commits): one cut off by the
          // next navigation belongs to the previous screen, which was already
          // checked in its own shot, so only the current document's are read.
          page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) gen.n += 1;
          });
          let outside = null;
          page.on('request', (req) => {
            requestedIn.set(req, gen.n);
            if (!isAllowedRequest(req.url(), BASE_URL)) outside = outside || req.url();
          });
          page.on('response', (res) => {
            const u = new URL(res.url());
            if (!u.pathname.startsWith('/api/') || u.pathname.startsWith('/api/stream')) return;
            if (String(res.headers()['content-type'] || '').includes('text/event-stream')) return;
            // A body that can't be read is recorded, not thrown: it fails the
            // shot at check time (fail-closed) instead of crashing the run.
            const g = requestedIn.get(res.request());
            bodies.push(res.text().then((body) => ({ url: u.pathname, body, gen: g }), (err) => ({ url: u.pathname, error: err.message, gen: g })));
          });
          const project = { current: 'Customer Experience Portal' };
          for (const shot of group) {
            const n = SHOTS.indexOf(shot) + 1;
            Object.assign(at, { shot: shot.id, lang, theme });
            await runShot({ page, shot, variant, n, run, terms, bodies, project, gen });
            if (outside) throw new CaptureFailure({ shot: shot.id, lang, theme, reason: 'the browser requested a host other than the demo app' });
          }
          await context.close();
        }
      }
    }
    const status = await getJson(`${BASE_URL}/api/demo/status`);
    if (status.realNetworkRequests !== 0 || status.unhandled.length > 0 || status.handlerErrors.length > 0) {
      throw new CaptureFailure({ reason: 'the demo reported a real network request or an unanswered call', status: { realNetworkRequests: status.realNetworkRequests, unhandled: status.unhandled.length, handlerErrors: status.handlerErrors.length } });
    }
    const target = promoteRun(run, { partial, extra: { realNetworkRequests: 0, seconds: Math.round((Date.now() - started) / 1000) } });
    console.log(`\n  ${run.shots.length} screenshots in ${Math.round((Date.now() - started) / 1000)}s → ${target}\n`);
  } catch (err) {
    failure = err instanceof CaptureFailure ? err.info : { ...at, reason: `capture error: ${err.message.split('\n')[0]}` };
  } finally {
    await browser.close();
  }
  if (failure) {
    failRun(run, failure);
    console.error(`\n  Capture failed, nothing published: ${JSON.stringify(failure)}\n`);
    process.exit(1);
  }
}

main();
