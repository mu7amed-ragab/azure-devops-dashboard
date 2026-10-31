#!/usr/bin/env node
/**
 * First step of `npm run demo`, before the build: refuses to continue when
 * this checkout is the folder the Windows service serves from, or when the
 * requested port is the real app's. Building first would already have
 * replaced the service's web/dist.
 */

const path = require('path');
const { assertNotDeploymentFolder } = require('../server/demo/guard');
const { REAL_DEFAULT_PORT } = require('../server/demo/constants');

try {
  assertNotDeploymentFolder(path.join(__dirname, '..'));
  if (Number(process.env.PORT) === REAL_DEFAULT_PORT) {
    throw new Error(`Demo mode refuses port ${REAL_DEFAULT_PORT}, the real app's port. Unset PORT or pick another.`);
  }
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}
