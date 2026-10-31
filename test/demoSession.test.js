/**
 * A demo session and a real one in the same browser must not touch each
 * other: different cookie names (cookies are shared across ports on one
 * host), and a different, per-process signing key that never comes from the
 * real SESSION_SECRET — so neither mode can read or overwrite the other's
 * session. Every case runs with SESSION_SECRET set, which is the setup most
 * likely to make the two keys collide.
 */

const fs = require('fs');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { withDemoConfig, withRealConfig } = require('./fixtures/demoConfig');
const { buildTestApp } = require('./fixtures/demoFlows');
const { deriveKey, seal } = require('../server/auth');

const REAL_SECRET = 'real-secret-for-test-at-least-32-bytes';
const ENV = { SESSION_SECRET: REAL_SECRET };

function names(res) {
  return (res.cookies || []).map((c) => c.name).sort();
}

suite('demo session isolation');

test('the demo secret never comes from SESSION_SECRET or a secret file, and differs per process start', async () => {
  let first;
  await withDemoConfig(
    async (config, root) => {
      fs.mkdirSync(path.join(root, 'data'), { recursive: true });
      fs.writeFileSync(path.join(root, 'data', 'session-secret'), 'a-secret-from-a-file');
      first = config.sessionSecret;
      assert.notStrictEqual(config.sessionSecret, REAL_SECRET);
      assert.notStrictEqual(config.sessionSecret, 'a-secret-from-a-file');
      assert.ok(!fs.existsSync(path.join(root, '.demo', 'data', 'session-secret')), 'the demo secret is never written');
    },
    { env: ENV }
  );
  await withDemoConfig(async (config) => assert.notStrictEqual(config.sessionSecret, first), { env: ENV });
  await withRealConfig(async (config) => assert.strictEqual(config.sessionSecret, REAL_SECRET), { env: ENV });
});

test('demo sign-in sets only demo cookie names; real sign-in keeps the real ones', async () => {
  await withDemoConfig(
    async (config) => {
      const { app, close } = await buildTestApp(config);
      try {
        const pw = await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'demo' } });
        assert.deepStrictEqual(names(pw), ['azdash_demo_gate']);
        const gate = pw.cookies[0].value;
        const pat = await app.inject({ method: 'POST', url: '/api/auth/pat', payload: { pat: 'demo-lead' }, cookies: { azdash_demo_gate: gate } });
        assert.strictEqual(pat.statusCode, 200, pat.body);
        assert.ok(names(pat).includes('azdash_demo_session'));
        assert.ok(!names(pat).some((n) => n === 'azdash_session' || n === 'azdash_gate'));
      } finally {
        await close();
      }
    },
    { env: ENV }
  );
  await withRealConfig(
    async (config) => {
      const { app, close } = await buildTestApp(config);
      try {
        const pw = await app.inject({ method: 'POST', url: '/api/auth/password', payload: { password: 'example-password' } });
        assert.deepStrictEqual(names(pw), ['azdash_gate']);
      } finally {
        await close();
      }
    },
    { env: ENV }
  );
});

test("a session sealed by one mode is not accepted by the other", async () => {
  const realSession = { v: 2, pat: 'x', id: 'id', displayName: 'Someone', uniqueName: 'someone@example.org', project: null, iat: Date.now() };
  let demoCookie;
  await withDemoConfig(
    async (config) => {
      const { app, close } = await buildTestApp(config);
      try {
        const sealedByReal = seal(realSession, deriveKey(REAL_SECRET));
        const asDemo = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { azdash_demo_session: sealedByReal, azdash_session: sealedByReal } });
        assert.strictEqual(JSON.parse(asDemo.body).stage, 'password');
        demoCookie = seal(realSession, deriveKey(config.sessionSecret));
      } finally {
        await close();
      }
    },
    { env: ENV }
  );
  await withRealConfig(
    async (config) => {
      const { app, close } = await buildTestApp(config);
      try {
        const asReal = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { azdash_session: demoCookie, azdash_demo_session: demoCookie } });
        assert.strictEqual(JSON.parse(asReal.body).stage, 'password');
        assert.strictEqual(JSON.parse(asReal.body).demo, undefined);
      } finally {
        await close();
      }
    },
    { env: ENV }
  );
});

test('demo defaults to its own port and refuses the real one; real mode keeps 5174', async () => {
  await withDemoConfig(async (config) => assert.strictEqual(config.port, 5180), { env: ENV });
  await assert.rejects(withDemoConfig(async () => {}, { env: { ...ENV, PORT: '5174' } }), /refuses port 5174/);
  await withRealConfig(async (config) => assert.strictEqual(config.port, 5174), { env: ENV });
});

module.exports = run;
