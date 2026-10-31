// CommonJS on purpose: Playwright is resolved from a machine-local install
// via NODE_PATH, which Node honors for require() but not for ESM import.
//
// Usage (from repo root, app already running on port 5174):
//   NODE_PATH="<path-to>/browser-tools/node_modules" node tools/verify-ui.cjs
//
// 

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = process.env.VERIFY_UI_BASE_URL || 'http://127.0.0.1:5174';
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
const ROUTES = ['/', '/work-items', '/pull-requests', '/team', '/scrum'];
const THEMES = ['light', 'dark'];
const LANGS = ['en', 'ar'];
// /team is the heaviest authenticated route (largest JS chunk, deepest
// component tree — org chart + member sections) — the route the SC-005
// language-switch timing budget is measured against.
const TIMING_ROUTE = '/team';

// Sign-in is mandatory now (the app has no PAT-is-the-identity mode), so every
// route below redirects to /login without a session. These drive the three-step
// gate over the API — the cookies land in the browser context, so the pages
// then load as a signed-in person would see them. Unset any of them and the
// app-route checks are skipped rather than reported as failures.
const LOGIN = {
  password: process.env.VERIFY_UI_PASSWORD || '',
  pat: process.env.VERIFY_UI_PAT || '',
  project: process.env.VERIFY_UI_PROJECT || '',
};

function log(...args) {
  console.log(...args);
}

function makeFail(failures) {
  return (msg) => {
    failures.push(msg);
    console.log('FAIL:', msg);
  };
}

async function run() {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const failures = [];
  const consoleIssues = [];
  const fail = makeFail(failures);
  const canSignIn = Boolean(LOGIN.password && LOGIN.pat && LOGIN.project);
  if (!canSignIn) {
    log(
      'VERIFY_UI_PASSWORD / VERIFY_UI_PAT / VERIFY_UI_PROJECT not all set — ' +
        'only /login is checked. Set all three to check the signed-in routes.'
    );
  }

  // The login screen, signed OUT, walked one step at a time — the project list
  // and the step rail get looked at rather than assumed. Not run per theme:
  // LoginPage forces its own night-sky shell regardless of the app's theme
  // (DESIGN.md "The Ambient Canopy"), so a second pass would be the same
  // pixels. It is also the ONE sign-in this script performs: the resulting
  // session is reused for both theme passes below, because POST
  // /api/auth/password is rate-limited to 5 attempts per 15 minutes per IP and
  // signing in once per theme burned through that in two runs.
  let signedInState = null;
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on('pageerror', (err) => consoleIssues.push(`/login pageerror: ${err.message}`));

    // `settled` is the selector that proves this step finished loading — the
    // project step fetches its list, so waiting on <form> alone captures its
    // spinner instead of the list.
    const shoot = async (name, settled = 'form') => {
      await page.goto(BASE_URL + '/login', { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector(settled, { timeout: 20000 });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
      log(`/login: screenshot -> ${name}.png`);
    };

    const post = async (url, data) => {
      const res = await context.request.post(BASE_URL + url, { data });
      if (!res.ok()) throw new Error(`${url} -> ${res.status()} ${(await res.text()).slice(0, 200)}`);
    };

    try {
      await shoot('login-1-password');

      // Arabic pass over the sign-in screen — client-side language toggle
      // only, no extra POSTs, so it doesn't touch the password rate limit.
      // Also checks the FR-002 requirement that the choice is available
      // before authentication.
      const langToggle = await page.$('button:has-text("العربية")');
      if (langToggle) {
        await langToggle.click();
        await page.waitForFunction(() => document.documentElement.dir === 'rtl', { timeout: 5000 });
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'login-1-password-ar.png'), fullPage: true });
        log('/login: screenshot -> login-1-password-ar.png');
        const dir = await page.evaluate(() => document.documentElement.dir);
        if (dir !== 'rtl') fail(`/login: switching to Arabic did not set <html dir="rtl"> (got "${dir}")`);
        // Back to English so the rest of this pass (and the reused signed-in
        // session below) starts from the same state every run.
        await (await page.$('button:has-text("English")'))?.click();
        await page.waitForFunction(() => document.documentElement.dir === 'ltr', { timeout: 5000 });
      } else {
        fail('/login: LanguageToggle not found on the sign-in page (FR-002)');
      }

      if (canSignIn) {
        await post('/api/auth/password', { password: LOGIN.password });
        await shoot('login-2-pat');
        await post('/api/auth/pat', { pat: LOGIN.pat });
        await shoot('login-3-project', 'input[name="project"]');
        await post('/api/auth/project', { project: LOGIN.project });
        signedInState = await context.storageState();
        log(`signed in (project: ${LOGIN.project})`);
      }
    } catch (err) {
      fail(`/login: ${err.message}`);
    }
    await context.close();
  }

  for (const theme of signedInState ? THEMES : []) {
    for (const lang of LANGS) {
      const tag = `${theme}/${lang}`;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        storageState: signedInState,
      });
      // Runs on every page load, i.e. after storageState is restored, so this
      // wins over whatever theme/language the reused session carried. Setting
      // 'lang' here (rather than clicking LanguageToggle per route) is what
      // lets each combination start from a clean, already-settled state —
      // the no-flash behaviour itself is checked separately below.
      await context.addInitScript(
        ({ t, l }) => {
          window.localStorage.setItem('theme', t);
          window.localStorage.setItem('lang', l);
        },
        { t: theme, l: lang }
      );

      const page = await context.newPage();
      // A 403 from a role-gated endpoint is expected steady state, not a defect:
      // /api/team answers 403 for anyone who isn't a lead/principal in the
      // signed-in project, and the client handles that (useTeam sets
      // `retry: false` precisely because it is an answer, not a failure). The
      // browser still logs every failed request as a console error, so without
      // this the whole run "fails" whenever it is driven with a PAT that has no
      // role in the chosen project — which is the common case on most projects.
      const EXPECTED_403_PATHS = ['/api/team', '/api/org', '/api/scrum'];
      const isExpectedRoleGate = (text) =>
        text.includes('403') && EXPECTED_403_PATHS.some((p) => text.includes(p));

      // Recorded so the check below can name the path; Playwright's console text
      // for a failed fetch does not always include the URL.
      let lastForbiddenUrl = '';
      page.on('response', (res) => {
        if (res.status() === 403) lastForbiddenUrl = res.url();
      });
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (isExpectedRoleGate(text) || (text.includes('403') && isExpectedRoleGate(lastForbiddenUrl))) {
          console.log(`[${tag}] ignoring expected role-gate 403 (${lastForbiddenUrl || text})`);
          return;
        }
        consoleIssues.push(`[${tag}] console.error: ${text}`);
      });
      page.on('pageerror', (err) => {
        consoleIssues.push(`[${tag}] pageerror: ${err.message}`);
      });

      const expectedDir = lang === 'ar' ? 'rtl' : 'ltr';

      for (const route of ROUTES) {
        const url = BASE_URL + route;
        let response;
        try {
          // 'networkidle' never resolves here: the app holds an open SSE
          // connection to /api/stream for live updates, so the network is
          // never idle. Wait for 'load', then poll for the SPA to mount.
          response = await page.goto(url, { waitUntil: 'load', timeout: 15000 });
          // #root gains children as soon as RequireAuth's "Checking sign-in
          // status…" spinner mounts, so waiting on that alone screenshots the
          // spinner. #main-content only exists once Layout itself has rendered.
          await page.waitForSelector('#main-content', { timeout: 20000 });
        } catch (err) {
          fail(`[${tag}] ${route}: navigation failed — ${err.message}`);
          continue;
        }

        // /team and /scrum are both role-gated (canSeeTeamPage) and bounce to /
        // if this PAT isn't a lead/principal/scrum account (FR-028).
        if (route === '/team' || route === '/scrum') {
          const finalUrl = new URL(page.url());
          if (finalUrl.pathname === '/' || finalUrl.pathname === '') {
            log(`[${tag}] ${route}: skipped (redirected to / — PAT is not lead/principal)`);
            continue;
          }
        }

        const root = await page.$('#root');
        const rootHtml = root ? await root.innerHTML() : '';
        if (!rootHtml || rootHtml.trim().length === 0) {
          fail(`[${tag}] ${route}: #root is empty — SPA did not mount`);
        }

        // No-flash / no-mixed-direction regression (T082): the pre-paint
        // script in index.html sets <html dir/lang> before React hydrates —
        // if it or the store ever drifted, this is what would catch it.
        const actualDir = await page.evaluate(() => document.documentElement.dir);
        const actualLang = await page.evaluate(() => document.documentElement.lang);
        if (actualDir !== expectedDir) {
          fail(`[${tag}] ${route}: <html dir="${actualDir}">, expected "${expectedDir}"`);
        }
        if (actualLang !== lang) {
          fail(`[${tag}] ${route}: <html lang="${actualLang}">, expected "${lang}"`);
        }

        const fileName = `${theme}-${lang}-${route === '/' ? 'dashboard' : route.slice(1)}.png`;
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, fileName), fullPage: true });
        log(`[${tag}] ${route}: screenshot -> ${fileName} (status ${response ? response.status() : 'n/a'})`);
      }

      // Font check: computed body font-family should resolve to InterVariable
      // — the declared font-family stack is language-invariant (Tailwind lists
      // InterVariable first regardless of which glyphs actually render), so
      // this check is unchanged by `lang`.
      await page.goto(BASE_URL + '/', { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#main-content', { timeout: 20000 });
      const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      if (!/InterVariable/i.test(fontFamily)) {
        fail(`[${tag}] body font-family does not include InterVariable: "${fontFamily}"`);
      } else {
        log(`[${tag}] font check ok: ${fontFamily}`);
      }

      // Focus-ring check: Tab through the page, flag any focused element with
      // neither an outline nor a box-shadow.
      const unstyledFocus = [];
      const TAB_COUNT = 25;
      for (let i = 0; i < TAB_COUNT; i++) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const hasOutline = cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px';
          const hasShadow = cs.boxShadow !== 'none';
          if (hasOutline || hasShadow) return null;
          return {
            tag: el.tagName,
            text: (el.textContent || '').trim().slice(0, 40),
            className: el.className && el.className.toString().slice(0, 80),
          };
        });
        if (info) unstyledFocus.push(info);
      }
      if (unstyledFocus.length > 0) {
        fail(
          `[${tag}] ${unstyledFocus.length} focused element(s) with no visible focus ring: ` +
            JSON.stringify(unstyledFocus)
        );
      } else {
        log(`[${tag}] focus-ring check ok (${TAB_COUNT} tabs, all had visible rings)`);
      }

      // Escape-closes-popover check (FR-016/FR-017): open a StateChip/Menu-
      // style listbox popover, press Escape, assert it unmounts, and — since
      // this now runs in RTL too — assert the panel stayed fully inside the
      // viewport (a flipped-side popover clipping off the edge is exactly the
      // kind of RTL alignment bug T081 is watching for).
      const trigger = await page.$('[aria-haspopup="listbox"]');
      if (trigger) {
        await trigger.click();
        const panelOpen = await page.$('[role="listbox"]');
        if (!panelOpen) {
          fail(`[${tag}] popover trigger clicked but no [role="listbox"] panel appeared`);
        } else {
          const box = await panelOpen.boundingBox();
          const viewport = page.viewportSize();
          if (box && viewport && (box.x < 0 || box.y < 0 || box.x + box.width > viewport.width)) {
            fail(`[${tag}] popover panel is clipped by the viewport: ${JSON.stringify(box)}`);
          }
          await page.keyboard.press('Escape');
          await page.waitForTimeout(100);
          const panelAfter = await page.$('[role="listbox"]');
          if (panelAfter) {
            fail(`[${tag}] Escape did not close the popover`);
          } else {
            log(`[${tag}] Escape-closes-popover check ok`);
          }
        }
      } else {
        log(`[${tag}] Escape-closes-popover check skipped (no [aria-haspopup="listbox"] trigger found on /)`);
      }

      await context.close();
    }
  }

  // Language-switch timing (SC-005): on the heaviest authenticated route,
  // click LanguageToggle and measure until the DOM direction actually flips —
  // that's the real user-perceived cost of a switch, not just the click
  // handler returning. Run once (light theme, starting from English) rather
  // than per theme/lang combo above — the cost is the re-render, which is
  // theme-independent.
  if (signedInState) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: signedInState });
    await context.addInitScript(() => {
      window.localStorage.setItem('theme', 'light');
      window.localStorage.setItem('lang', 'en');
    });
    const page = await context.newPage();
    try {
      await page.goto(BASE_URL + TIMING_ROUTE, { waitUntil: 'load', timeout: 15000 });
      await page.waitForSelector('#main-content', { timeout: 20000 });
      const finalUrl = new URL(page.url());
      if (finalUrl.pathname !== TIMING_ROUTE) {
        log(`language-switch timing: skipped (${TIMING_ROUTE} redirected to ${finalUrl.pathname} — PAT is not lead/principal)`);
      } else {
        const toggle = await page.$('button:has-text("العربية")');
        if (!toggle) {
          fail(`language-switch timing: LanguageToggle not found on ${TIMING_ROUTE}`);
        } else {
          const start = Date.now();
          await toggle.click();
          await page.waitForFunction(() => document.documentElement.dir === 'rtl', { timeout: 5000 });
          const elapsedMs = Date.now() - start;
          log(`language-switch timing: ${TIMING_ROUTE} en->ar in ${elapsedMs}ms`);
          if (elapsedMs > 2000) {
            fail(`language-switch timing: ${TIMING_ROUTE} took ${elapsedMs}ms, budget is 2000ms (SC-005)`);
          }
        }
      }
    } catch (err) {
      fail(`language-switch timing: ${err.message}`);
    }
    await context.close();
  }

  await browser.close();

  log('\n--- Console/page errors ---');
  if (consoleIssues.length === 0) {
    log('none');
  } else {
    consoleIssues.forEach((i) => log(i));
    fail(`${consoleIssues.length} console error(s)/pageerror(s) — see above`);
  }

  log('\n--- Summary ---');
  if (failures.length === 0) {
    log('All checks passed. Screenshots in', SCREENSHOT_DIR);
    log('Open them and look — a blank frame means the SPA never mounted, which assertions alone will not catch.');
    process.exit(0);
  } else {
    log(`${failures.length} check(s) failed:`);
    failures.forEach((f) => log(' - ' + f));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('verify-ui.cjs crashed:', err);
  process.exit(1);
});
