/**
 * Fixed values for demo mode — the fictional organization the app serves
 * when DEMO_MODE is on. Nothing here names a real organization, person or
 * project; see server/demo/README.md.
 */

const DEMO_ORG = 'masar';
const DEMO_OWNER = 'mona.ahmed@masar.dev';
const DEMO_PASSWORD = 'demo';
const DEMO_DEFAULT_PROJECT = 'Customer Experience Portal';
const DEMO_DEFAULT_SEED = 20261029;

// The real app's default port. Demo mode refuses it so the two never share a
// browser origin — localStorage (and the Clear Cache sweep over it) is
// per-origin, so a different port is what keeps their saved state apart.
const DEMO_DEFAULT_PORT = 5180;
const REAL_DEFAULT_PORT = 5174;

// Browsers scope cookies by host, not port, so demo and real sessions on
// 127.0.0.1 need different cookie names or one sign-in overwrites the other.
const DEMO_COOKIES = { session: 'azdash_demo_session', gate: 'azdash_demo_gate' };

// Personal access tokens accepted by the demo, mapped to person keys from
// server/demo/seed/people.js. Any other token is rejected with a 401.
const DEMO_TOKENS = {
  'demo-lead': 'mona',
  'demo-member': 'mohammed',
  'demo-principal': 'sara',
};

module.exports = {
  DEMO_ORG,
  DEMO_OWNER,
  DEMO_PASSWORD,
  DEMO_DEFAULT_PROJECT,
  DEMO_DEFAULT_SEED,
  DEMO_DEFAULT_PORT,
  REAL_DEFAULT_PORT,
  DEMO_COOKIES,
  DEMO_TOKENS,
};
