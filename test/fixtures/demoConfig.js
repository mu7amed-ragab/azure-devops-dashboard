/**
 * Runs a test body against the REAL demo configuration path — loadConfig()
 * with DEMO_MODE on — rooted in a temporary folder, so the deployment guard,
 * the transport latch and every demo path are exercised exactly as in
 * production while nothing is written inside the repository.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_PATH = require.resolve('../../server/config');

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `azdash-${label}-`));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), `azdash-${label}-service-`));
  fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'deploy', 'azure-dashboard.xml'),
    `<service>\n  <id>azure-dashboard</id>\n  <workingdirectory>${elsewhere}</workingdirectory>\n</service>\n`
  );
  return { root, elsewhere };
}

function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return { restore };
}

function freshConfigModule() {
  delete require.cache[CONFIG_PATH];
  return require(CONFIG_PATH);
}

async function withDemoConfig(fn, { env = {}, label = 'demo' } = {}) {
  const { root, elsewhere } = tempRoot(label);
  const { restore } = withEnv({ DEMO_MODE: '1', PORT: undefined, ...env }, () => {});
  const client = require('../../server/ado/client');
  try {
    const { loadConfig } = freshConfigModule();
    const config = loadConfig({ repoRoot: root });
    return await fn(config, root);
  } finally {
    client.resetTransportForTests();
    restore();
    delete require.cache[CONFIG_PATH];
    require('../../server/demo').reseed();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
}

async function withRealConfig(fn, { env = {}, label = 'real' } = {}) {
  const { root, elsewhere } = tempRoot(label);
  const { restore } = withEnv({ DEMO_MODE: undefined, ADO_ORG: 'example-org', APP_PASSWORD: 'example-password', PORT: undefined, ...env }, () => {});
  try {
    const { loadConfig } = freshConfigModule();
    const config = loadConfig({ repoRoot: root });
    return await fn(config, root);
  } finally {
    restore();
    delete require.cache[CONFIG_PATH];
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
}

module.exports = { withDemoConfig, withRealConfig, tempRoot };
