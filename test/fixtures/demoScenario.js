/**
 * Child-process entry for test/demoNetworkIsolation.test.js. Runs every flow
 * against the demo organization with test/fixtures/denyIO.js preloaded and
 * prints what it counted as a single JSON line. With `--real-mode-load-check`
 * it instead builds a real-mode client and reports whether any demo module
 * was loaded.
 */

const { withDemoConfig, withRealConfig } = require('./demoConfig');
const { runAllFlows, buildTestApp } = require('./demoFlows');

async function scenario() {
  const client = require('../../server/ado/client');
  let unhandled = null;
  let handlerErrors = null;
  await withDemoConfig(
    async (config) => {
      const { app, close } = await buildTestApp(config);
      try {
        await runAllFlows({ app, config });
        const state = require('../../server/demo').getState();
        unhandled = [...state.unhandled];
        handlerErrors = state.handlerErrors.slice();
      } finally {
        await close();
      }
    },
    { env: { SESSION_SECRET: 'dummy-secret-for-isolation-check', ADO_ORG: 'dummy-org', ADO_PAT: 'dummy-pat', APP_PASSWORD: 'dummy' } }
  );
  const io = global.__denyIO || { networkAttempts: null, fsViolations: null, details: [] };
  return { networkAttempts: io.networkAttempts, fsViolations: io.fsViolations, details: io.details, realRequestCount: client.getRealRequestCount(), unhandled, handlerErrors };
}

async function realModeLoadCheck() {
  let loaded = null;
  await withRealConfig(async (config) => {
    const { AdoClient } = require('../../server/ado/client');
    new AdoClient({ ...config, pat: 'x' }); // eslint-disable-line no-new
    loaded = Object.keys(require.cache).filter((k) => /[\\/]server[\\/]demo[\\/]/.test(k));
  });
  return { demoModulesLoaded: loaded };
}

(async () => {
  const result = process.argv.includes('--real-mode-load-check') ? await realModeLoadCheck() : await scenario();
  process.stdout.write(`\n${JSON.stringify(result)}\n`);
  process.exit(0);
})().catch((err) => {
  process.stdout.write(`\n${JSON.stringify({ error: err.stack || String(err) })}\n`);
  process.exit(1);
});
