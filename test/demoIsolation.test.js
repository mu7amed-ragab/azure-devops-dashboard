/**
 * Demo mode must be impossible to start by accident and impossible to fall
 * back from: an exact switch read only from the process environment, a
 * refusal to run from the service's own folder, every path under `.demo`,
 * and a process-wide transport that no client can bypass.
 */

const fs = require('fs');
const path = require('path');
const { suite, test, run, assert } = require('./harness');
const { withDemoConfig, withRealConfig, tempRoot } = require('./fixtures/demoConfig');
const client = require('../server/ado/client');
const { assertNotDeploymentFolder } = require('../server/demo/guard');

suite('demo mode switch, guard, paths and transport latch');

test('DEMO_MODE accepts only exact on/off values and never comes from .env', () => {
  const { resolveDemoSwitch } = require('../server/config');
  for (const v of ['1', 'true', 'on', 'ON ', 'True']) assert.strictEqual(resolveDemoSwitch({ processValue: v }), 'on', v);
  for (const v of [undefined, '', '0', 'false', 'off', ' OFF']) assert.strictEqual(resolveDemoSwitch({ processValue: v }), 'off', String(v));
  for (const v of ['yes', '2', 'demo', 'enabled']) {
    assert.throws(() => resolveDemoSwitch({ processValue: v }), /DEMO_MODE must be one of/, v);
  }
  assert.throws(() => resolveDemoSwitch({ processValue: undefined, envFileHasDemo: true }), /process environment, not in \.env/);
});

test('demo config lives entirely under <root>/.demo and ignores real credentials', async () => {
  await withDemoConfig(
    async (config, root) => {
      const demoRoot = path.join(root, '.demo');
      for (const key of ['cacheDir', 'dataDir', 'orgDataDir']) assert.ok(config[key].startsWith(demoRoot), `${key} = ${config[key]}`);
      assert.strictEqual(config.org, 'masar');
      assert.strictEqual(config.pat, '');
      assert.strictEqual(config.appPassword, 'demo');
      assert.strictEqual(config.demo, true);
      assert.notStrictEqual(config.sessionSecret, 'a-real-secret');
    },
    { env: { ADO_PAT: 'real-pat', ADO_ORG: 'real-org', APP_PASSWORD: 'real-password', SESSION_SECRET: 'a-real-secret' } }
  );
});

test('the guard refuses the service folder, a missing or tagless definition, and allows elsewhere', () => {
  const { root, elsewhere } = tempRoot('guard');
  try {
    assert.doesNotThrow(() => assertNotDeploymentFolder(root));
    const xml = path.join(root, 'deploy', 'azure-dashboard.xml');
    fs.writeFileSync(xml, `<service><workingdirectory>${root.toUpperCase()}</workingdirectory></service>`);
    if (process.platform === 'win32') assert.throws(() => assertNotDeploymentFolder(root), /folder the Windows service runs from/);
    fs.writeFileSync(xml, `<service><workingdirectory>${root}</workingdirectory></service>`);
    assert.throws(() => assertNotDeploymentFolder(root), /folder the Windows service runs from/);
    fs.writeFileSync(xml, '<service></service>');
    assert.throws(() => assertNotDeploymentFolder(root), /no <workingdirectory>/);
    fs.rmSync(xml);
    assert.throws(() => assertNotDeploymentFolder(root), /could not be read/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('demo config refuses the real port', async () => {
  await assert.rejects(withDemoConfig(async () => {}, { env: { PORT: '5174' } }), /refuses port 5174/);
  await withDemoConfig(async (config) => assert.strictEqual(config.port, 5180));
});

test('every client in a demo process uses the demo transport, and a mismatched config throws', async () => {
  const before = client.getRealRequestCount();
  await withDemoConfig(async (config) => {
    const { demoRequest } = require('../server/demo/transport');
    const c = new client.AdoClient({ ...config, project: 'Customer Experience Portal', pat: 'demo-lead' });
    assert.strictEqual(c.transport, demoRequest);
    const cats = await c.get('/wit/workitemtypecategories');
    assert.ok(cats.value.length > 0);
    assert.throws(() => new client.AdoClient({ ...config, demo: undefined, pat: 'x' }), /Real AdoClient constructed in a demo process/);
  });
  assert.throws(() => new client.AdoClient({ org: 'masar', demo: true, pat: 'x' }), /Demo config without a demo transport/);
  assert.strictEqual(client.getRealRequestCount(), before);
});

test('real mode keeps today’s config, cookie names and network transport', async () => {
  await withRealConfig(async (config, root) => {
    assert.strictEqual(config.demo, undefined);
    assert.strictEqual(config.port, 5174);
    assert.strictEqual(config.cacheDir, path.join(root, '.cache'));
    assert.deepStrictEqual(config.cookieNames, { session: 'azdash_session', gate: 'azdash_gate' });
    const c = new client.AdoClient({ ...config, pat: 'x' });
    assert.notStrictEqual(c.transport, require('../server/demo/transport').demoRequest);
  });
});

module.exports = run;
