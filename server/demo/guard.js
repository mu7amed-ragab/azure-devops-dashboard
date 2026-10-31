const fs = require('fs');
const path = require('path');

/**
 * Demo mode must never run from the folder the Windows service runs from:
 * `npm run demo` rebuilds web/dist, and that folder's web/dist is what the
 * service serves to real users. The service's folder is read from the
 * service definition checked into this repo, so the check needs no
 * machine-specific configuration. Anything it cannot read is a refusal.
 */

const SERVICE_XML = path.join('deploy', 'azure-dashboard.xml');

class DeploymentFolderError extends Error {}

/** The service's working directory as written in its definition file, or
 * null when the file has no such element. Throws if the file can't be read. */
function readServiceWorkingDirectory(repoRoot) {
  const file = path.join(repoRoot, SERVICE_XML);
  let xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new DeploymentFolderError(
      `Demo mode needs ${SERVICE_XML} to confirm it is not running from the service folder, but it could not be read (${err.code || err.message}).`
    );
  }
  const match = /<workingdirectory>([^<]+)<\/workingdirectory>/i.exec(xml);
  return match ? match[1].trim() : null;
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertNotDeploymentFolder(repoRoot) {
  const workingDirectory = readServiceWorkingDirectory(repoRoot);
  if (!workingDirectory) {
    throw new DeploymentFolderError(`${SERVICE_XML} has no <workingdirectory>, so demo mode cannot confirm it is safe to run here.`);
  }
  let serviceDir;
  try {
    serviceDir = fs.realpathSync.native(workingDirectory);
  } catch (err) {
    // The service folder doesn't exist on this machine, so it can't be this one.
    return;
  }
  const here = fs.realpathSync.native(repoRoot);
  if (samePath(serviceDir, here)) {
    throw new DeploymentFolderError(
      `Demo mode cannot run from the folder the Windows service runs from (${here}). Use the demo worktree.`
    );
  }
}

module.exports = { assertNotDeploymentFolder, readServiceWorkingDirectory, DeploymentFolderError };
