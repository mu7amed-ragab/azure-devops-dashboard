/**
 * Preloaded (`node -r`) into a child process by test/demoNetworkIsolation.test.js.
 * Every way out of the process onto the network is blocked and counted, as
 * are reads of the real configuration, cache and data folders and any write
 * outside the allowed roots. The counts end up on `global.__denyIO`.
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const repo = path.resolve(__dirname, '..', '..');
const counters = { networkAttempts: 0, fsViolations: 0, details: [] };
global.__denyIO = counters;

const allowedRoots = (process.env.DENYIO_ALLOWED_ROOTS || '').split(path.delimiter).filter(Boolean).map((p) => path.resolve(p).toLowerCase());
const forbiddenReads = ['.env', '.cache', 'data'].map((p) => path.join(repo, p).toLowerCase());

function blockNetwork(name) {
  return function blocked() {
    counters.networkAttempts += 1;
    counters.details.push(`network: ${name}`);
    throw new Error(`denyIO: ${name} is blocked in this process`);
  };
}

for (const [modName, fns] of [
  ['net', ['connect', 'createConnection']],
  ['tls', ['connect']],
  ['http', ['request', 'get']],
  ['https', ['request', 'get']],
  ['dns', ['lookup', 'resolve', 'resolve4', 'resolve6']],
]) {
  const mod = require(modName);
  for (const fn of fns) mod[fn] = blockNetwork(`${modName}.${fn}`);
}
if (typeof globalThis.fetch === 'function') globalThis.fetch = blockNetwork('fetch');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  const exported = originalLoad.apply(this, arguments);
  if (request === 'undici' && exported && !exported.__denied) {
    const patched = { ...exported, request: blockNetwork('undici.request'), fetch: blockNetwork('undici.fetch'), __denied: true };
    return patched;
  }
  return exported;
};

function resolved(p) {
  if (typeof p !== 'string' && !(p instanceof URL) && !Buffer.isBuffer(p)) return null;
  try {
    // Windows long-path form (\\?\C:\...) names the same file as C:\...
    const raw = String(p instanceof URL ? p.pathname : p).replace(/^\\\\\?\\/, '');
    return path.resolve(raw).toLowerCase();
  } catch (err) {
    return null;
  }
}

function under(file, root) {
  return file === root || file.startsWith(root + path.sep);
}

function guardRead(name, original) {
  return function guarded(p, ...rest) {
    const file = resolved(p);
    if (file && forbiddenReads.some((root) => under(file, root))) {
      counters.fsViolations += 1;
      counters.details.push(`read: ${name} ${file}`);
      throw new Error(`denyIO: reading ${file} is not allowed`);
    }
    return original.call(this, p, ...rest);
  };
}

function guardWrite(name, original) {
  return function guarded(p, ...rest) {
    const file = resolved(p);
    if (file && !allowedRoots.some((root) => under(file, root))) {
      counters.fsViolations += 1;
      counters.details.push(`write: ${name} ${file}`);
      throw new Error(`denyIO: writing ${file} is not allowed`);
    }
    return original.call(this, p, ...rest);
  };
}

const READS = ['readFileSync', 'readFile', 'readdirSync', 'readdir', 'statSync', 'stat', 'lstatSync', 'existsSync', 'createReadStream'];
const WRITES = ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'rmSync', 'rm', 'renameSync', 'rename', 'unlinkSync', 'unlink', 'copyFileSync', 'copyFile', 'createWriteStream', 'rmdirSync', 'rmdir'];
for (const fn of READS) if (typeof fs[fn] === 'function') fs[fn] = guardRead(fn, fs[fn]);
for (const fn of WRITES) if (typeof fs[fn] === 'function') fs[fn] = guardWrite(fn, fs[fn]);
for (const fn of ['readFile', 'readdir', 'stat']) if (fs.promises[fn]) fs.promises[fn] = guardRead(`promises.${fn}`, fs.promises[fn]);
for (const fn of ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'unlink', 'copyFile', 'rmdir']) {
  if (fs.promises[fn]) fs.promises[fn] = guardWrite(`promises.${fn}`, fs.promises[fn]);
}
const originalOpenSync = fs.openSync;
fs.openSync = function openSync(p, flags, ...rest) {
  const writing = typeof flags === 'string' ? /[wa+]/.test(flags) : typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
  if (writing) return guardWrite('openSync', originalOpenSync).call(this, p, flags, ...rest);
  return guardRead('openSync', originalOpenSync).call(this, p, flags, ...rest);
};
