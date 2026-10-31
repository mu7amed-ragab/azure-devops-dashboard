const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEMO_ON = ['1', 'true', 'on'];
const DEMO_OFF = ['', '0', 'false', 'off'];

/** Demo mode is switched on from the process environment only, and only by
 * an exact value — anything unexpected stops startup rather than silently
 * running against real data. A DEMO_MODE line in .env is refused too, so the
 * deployed service can't be flipped into demo mode by editing that file. */
function resolveDemoSwitch({ processValue, envFileHasDemo }) {
  if (processValue === undefined) {
    if (envFileHasDemo) throw new Error('DEMO_MODE must be set in the process environment, not in .env');
    return 'off';
  }
  const value = String(processValue).trim().toLowerCase();
  if (DEMO_ON.includes(value)) return 'on';
  if (DEMO_OFF.includes(value)) return 'off';
  throw new Error(`DEMO_MODE must be one of: ${[...DEMO_ON, ...DEMO_OFF.filter(Boolean)].join(', ')} (or unset)`);
}

// Read before .env is loaded, so the switch can only come from the process
// environment. In demo mode .env is never loaded at all.
const RAW_DEMO_SWITCH = process.env.DEMO_MODE;
const demoRequested = RAW_DEMO_SWITCH !== undefined && DEMO_ON.includes(String(RAW_DEMO_SWITCH).trim().toLowerCase());
let envFileHasDemo = false;
if (!demoRequested) {
  const loaded = require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  envFileHasDemo = Boolean(loaded.parsed && Object.prototype.hasOwnProperty.call(loaded.parsed, 'DEMO_MODE'));
}

// ADO_PROJECT and ADO_PAT are deliberately NOT required: the project is now
// picked per person at sign-in from the list their own token can read (see
// server/ado/projects.js), and ADO_PAT is only the *preferred* shared read
// token — a project it can't see falls back to the PAT of whoever opened that
// project (see server/scopes.js electReadToken).
const REQUIRED = ['ADO_ORG', 'APP_PASSWORD'];

/**
 * The AES key material behind every session cookie (server/auth.js). Env var
 * wins; otherwise a generated secret is persisted under data/ so restarting
 * the server doesn't sign everyone out — that file, not a mandatory .env
 * edit, is what lets a local run mirror the hosted deployment's login flow
 * out of the box. On a host with an ephemeral disk (e.g. Render's free tier)
 * that file vanishes per deploy, so production is warned to set the env var.
 */
function resolveSessionSecret(dataDir) {
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv) return { secret: fromEnv, source: 'env' };

  const file = path.join(dataDir, 'session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return { secret: existing, source: file };
  } catch {
    // not created yet — fall through and generate one
  }

  const secret = crypto.randomBytes(32).toString('base64');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    // eslint-disable-next-line no-console
    console.log(`  Generated a session secret at ${file} — set SESSION_SECRET in .env to control it yourself.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`  Could not persist a session secret to ${file} (${err.message}) — sessions will not survive a restart.`);
  }
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      '  SESSION_SECRET is not set. On a host with no persistent disk this signs everyone out on every deploy — set it explicitly.'
    );
  }
  return { secret, source: file };
}

/** Every demo path lives under `<repoRoot>/.demo`, the session secret is
 * generated in memory per process (never taken from SESSION_SECRET or a
 * file), and the in-process demo transport is installed before any client
 * can be built. Nothing from .env or the real environment is read here. */
function loadDemoConfig(repoRoot) {
  const { assertNotDeploymentFolder } = require('./demo/guard');
  const constants = require('./demo/constants');
  assertNotDeploymentFolder(repoRoot);

  const port = Number(process.env.PORT) || constants.DEMO_DEFAULT_PORT;
  if (port === constants.REAL_DEFAULT_PORT) {
    throw new Error(`Demo mode refuses port ${constants.REAL_DEFAULT_PORT}, the real app's port. Unset PORT or pick another.`);
  }

  require('./ado/client').installDemoTransport(require('./demo/transport').demoRequest);

  const demoDir = path.join(repoRoot, '.demo');
  const dataDir = path.join(demoDir, 'data');
  return {
    org: constants.DEMO_ORG,
    defaultProject: constants.DEMO_DEFAULT_PROJECT,
    pat: '',
    apiVersion: '7.1',
    port,
    host: process.env.HOST || '127.0.0.1',
    syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS) || 900000,
    cacheDir: path.join(demoDir, 'cache'),
    webDist: path.join(repoRoot, 'web', 'dist'),
    ownerEmail: constants.DEMO_OWNER,
    rolesWikiPage: '/Dashboard Roles',
    dataDir,
    orgDataDir: path.join(dataDir, 'org'),
    maxProjectScopes: 8,
    prHistoryMonths: 12,
    appPassword: constants.DEMO_PASSWORD,
    sessionSecret: crypto.randomBytes(32).toString('base64'),
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS) || 720,
    cookieNames: { ...constants.DEMO_COOKIES },
    authEnabled: true,
    demo: true,
    demoSeed: Number(process.env.DEMO_SEED) || constants.DEMO_DEFAULT_SEED,
  };
}

function loadConfig({ repoRoot = path.join(__dirname, '..') } = {}) {
  if (resolveDemoSwitch({ processValue: RAW_DEMO_SWITCH, envFileHasDemo }) === 'on') {
    return loadDemoConfig(repoRoot);
  }

  const missing = REQUIRED.filter((key) => !process.env[key] || String(process.env[key]).trim() === '');

  if (missing.length > 0) {
    const lines = [
      '',
      '  Azure DevOps dashboard cannot start — missing required configuration:',
      ...missing.map((key) => `    - ${key}`),
      '',
      '  Fix: copy .env.example to .env in the project root and fill in the values.',
      `  Expected file: ${path.join(__dirname, '..', '.env')}`,
      '',
    ];
    // eslint-disable-next-line no-console
    console.error(lines.join('\n'));
    process.exit(1);
  }

  const appPassword = process.env.APP_PASSWORD;
  const dataDir = path.join(repoRoot, 'data');
  const { secret: sessionSecret } = resolveSessionSecret(dataDir);
  const host = process.env.HOST || '127.0.0.1';

  return {
    org: process.env.ADO_ORG.trim(),
    // The project a person's own PAT can't override — only the entry
    // preselected on the sign-in project step. There is no process-wide
    // "current project" any more; see server/scopes.js.
    defaultProject: (process.env.ADO_PROJECT || '').trim() || null,
    pat: (process.env.ADO_PAT || '').trim(),
    apiVersion: process.env.ADO_API_VERSION || '7.1',
    port: Number(process.env.PORT) || 5174,
    host,
    // 15 min: data is also push-refreshed on every write and via SSE, so this
    // only governs idle background polling — kept low enough to notice
    // teammates' changes, high enough to stay well under ADO's per-identity
    // rate-limiting threshold (see server/ado/client.js).
    syncIntervalMs: Number(process.env.SYNC_INTERVAL_MS) || 900000,
    cacheDir: path.join(repoRoot, '.cache'),
    webDist: path.join(repoRoot, 'web', 'dist'),
    // Who can clear the shared cache / trigger a full project-wide resync —
    // both destructive/expensive actions now reachable by anyone signed in.
    // Defaults to the service ADO_PAT's own identity when unset, so a
    // single-user deployment (no ADO_OWNER_EMAIL configured) behaves exactly
    // as before. See sync.isOwner.
    ownerEmail: (process.env.ADO_OWNER_EMAIL || '').trim().toLowerCase(),
    // The page (on each project's OWN wiki) that durably holds that project's
    // org chart — read and written on every load/save, so it survives hosts
    // with no persistent disk (e.g. Render's free tier). The wiki *name* is
    // derived per project in server/scopes.js (`<project>.wiki`); only the
    // page path is global, since it's the same page in every project. See
    // server/org.js's renderOrgMarkdown/parseOrgMarkdown.
    rolesWikiPage: process.env.ADO_ROLES_WIKI_PAGE || '/Dashboard Roles',
    dataDir,
    // Best-effort local cache of each project's org chart (one file per
    // project, named by scope slug) so a read doesn't have to hit the wiki on
    // every request — deliberately outside .cache/ so clearing the cache
    // never wipes it, though it's disposable either way since the wiki is the
    // durable copy. See server/orgStore.js and server/scopes.js.
    orgDataDir: process.env.ORG_DATA_DIR || path.join(dataDir, 'org'),
    // How many project scopes (each an AdoClient + SyncEngine + disk cache)
    // stay resident at once. The revision index dominates their memory, so
    // this is the knob that bounds it — see server/scopes.js evictIdle.
    maxProjectScopes: Number(process.env.MAX_PROJECT_SCOPES) || 8,
    // How far back PR history is attributed/rendered — a PR that's still
    // `active` is always kept regardless of age. 0 disables the cutoff
    // entirely (full history, as before this option existed).
    prHistoryMonths: process.env.ADO_PR_HISTORY_MONTHS === undefined ? 12 : Number(process.env.ADO_PR_HISTORY_MONTHS),
    // The gate every deployment goes through, local included: a shared
    // APP_PASSWORD unlocks a form where each person enters their own ADO PAT
    // (which becomes their session identity — server/auth.js) and then picks
    // a project. Always on, so a local run is the same flow as the hosted one
    // rather than a second, PAT-is-the-identity code path to reason about.
    appPassword,
    sessionSecret,
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS) || 720,
    // Kept as a field (the client's /api/auth/me contract and UserChip still
    // read it) but no longer a mode — there is only one auth path now.
    authEnabled: true,
    cookieNames: { session: 'azdash_session', gate: 'azdash_gate' },
  };
}

module.exports = { loadConfig, resolveDemoSwitch };
