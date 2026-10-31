/**
 * Loads and validates the list of real names that must never appear in a
 * published screenshot. It lives outside every repository and is never
 * printed. The capture refuses to run unless the list can be read, is long
 * enough, has an Arabic entry, and covers the real organization, the real
 * default project and every real project ever opened on this machine — read
 * from the Windows service's own folder. Errors name what is missing, never
 * a value.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');
const { readServiceWorkingDirectory } = require('../../server/demo/guard');
const { normalize, compact, hasArabic } = require('./normalize');

const MIN_TERMS = 10;
const MIN_REQUIRED_LENGTH = 3;

class DenyListError extends Error {
  constructor(category, message) {
    super(message);
    this.category = category;
  }
}

function defaultFile() {
  return process.env.DEMO_DENYLIST || path.join(os.homedir(), '.azure-dashboard', 'denylist.txt');
}

function defaultServiceDir(repoRoot) {
  if (process.env.DEMO_SERVICE_DIR) return process.env.DEMO_SERVICE_DIR;
  let dir;
  try {
    dir = readServiceWorkingDirectory(repoRoot);
  } catch (err) {
    throw new DenyListError('unreadable-source', 'The service definition (deploy/azure-dashboard.xml) could not be read.');
  }
  if (!dir) throw new DenyListError('unreadable-source', 'The service definition names no working directory.');
  return dir;
}

/** The real names the list must cover, as `{category, name}` — never shown. */
function requiredNames(serviceDir) {
  let env;
  try {
    env = dotenv.parse(fs.readFileSync(path.join(serviceDir, '.env')));
  } catch (err) {
    throw new DenyListError('unreadable-source', "The service's configuration could not be read, so the required names can't be checked.");
  }
  const required = [];
  required.push({ category: 'organization name', name: env.ADO_ORG || '' });
  if (env.ADO_PROJECT) required.push({ category: 'default project name', name: env.ADO_PROJECT });

  let entries;
  try {
    entries = fs.readdirSync(path.join(serviceDir, '.cache'), { withFileTypes: true });
  } catch (err) {
    throw new DenyListError('unreadable-source', "The service's cache folder could not be listed, so the projects opened there can't be checked.");
  }
  let n = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const m = /^(.*)-[0-9a-f]{8}$/i.exec(entry.name);
    n += 1;
    required.push({ category: `real project #${n}`, name: m ? m[1] : entry.name });
  }
  return required;
}

function loadDenyList({ file = defaultFile(), serviceDir, repoRoot = path.join(__dirname, '..', '..') } = {}) {
  if (!fs.existsSync(file)) throw new DenyListError('missing', `Refusing to capture: no deny list at ${file}.`);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new DenyListError('unreadable', `Refusing to capture: the deny list at ${file} could not be read.`);
  }
  const terms = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const value = raw.trim();
    if (!value || value.startsWith('#')) return;
    terms.push({ line: i + 1, norm: normalize(value), compact: compact(value), arabic: hasArabic(value) });
  });
  if (terms.length < MIN_TERMS) throw new DenyListError('too-short', `Refusing to capture: the deny list has ${terms.length} terms; at least ${MIN_TERMS} are required.`);
  if (!terms.some((t) => t.arabic)) throw new DenyListError('no-arabic', 'Refusing to capture: the deny list has no Arabic-script term.');

  for (const { category, name } of requiredNames(serviceDir || defaultServiceDir(repoRoot))) {
    const key = compact(name);
    if (key.length < MIN_REQUIRED_LENGTH) {
      throw new DenyListError(`required-name-unusable:${category}`, `Refusing to capture: the ${category} is missing or too short to check.`);
    }
    if (!terms.some((t) => t.compact.includes(key))) {
      throw new DenyListError(`not-covered:${category}`, `Refusing to capture: the deny list does not cover the ${category}.`);
    }
  }
  return { terms };
}

module.exports = { loadDenyList, DenyListError, MIN_TERMS };
