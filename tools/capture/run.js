/**
 * Where a capture run writes. Every run writes into its own staging folder;
 * only a run that passed every check replaces the published folder, as a
 * whole. A failed run leaves the previous published set untouched and
 * removes its own partial output, so a contact sheet can never mix runs or
 * include an image from a run that failed.
 */

const fs = require('fs');
const path = require('path');

function startRun(root) {
  fs.mkdirSync(root, { recursive: true });
  // Output left by a run that crashed before it could clean up.
  for (const name of fs.readdirSync(root)) {
    if (name.startsWith('.staging-')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(root, `.staging-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, startedAt: new Date().toISOString(), shots: [] };
}

function shotPath(run, lang, theme, n, id) {
  const folder = path.join(run.dir, `${lang}-${theme}`);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `${String(n).padStart(2, '0')}-${id}.png`);
  run.shots.push({ id, lang, theme, file: path.relative(run.dir, file).split(path.sep).join('/') });
  return file;
}

/** `info` must describe what failed (shot, variant, source, deny-list line)
 * and never carry a matched value. */
function failRun(run, info) {
  fs.rmSync(run.dir, { recursive: true, force: true });
  fs.writeFileSync(path.join(run.root, 'last-failure.json'), JSON.stringify({ at: new Date().toISOString(), ...info }, null, 2));
}

function contactSheet(shots) {
  const byId = new Map();
  for (const s of shots) {
    if (!byId.has(s.id)) byId.set(s.id, []);
    byId.get(s.id).push(s);
  }
  const rows = [...byId.entries()]
    .map(
      ([id, variants]) =>
        `<section><h2>${id}</h2><div class="row">${variants
          .map((v) => `<figure><a href="${v.file}"><img src="${v.file}" alt="${id} ${v.lang} ${v.theme}" loading="lazy"></a><figcaption>${v.lang} · ${v.theme}</figcaption></figure>`)
          .join('')}</div></section>`
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Screenshots</title><style>
body{font:14px system-ui,sans-serif;margin:24px;background:#f6f7f9;color:#1b1f24}
h2{font-size:15px;margin:24px 0 8px}.row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
figure{margin:0}img{width:100%;border:1px solid #d6dbe1;border-radius:6px;background:#fff}figcaption{font-size:12px;color:#5b6570;margin-top:4px}
</style></head><body><h1>Screenshots</h1>${rows}</body></html>`;
}

function promoteRun(run, { partial = false, extra = {} } = {}) {
  const report = { startedAt: run.startedAt, finishedAt: new Date().toISOString(), partial, shots: run.shots, ...extra };
  fs.writeFileSync(path.join(run.dir, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(run.dir, 'index.html'), contactSheet(run.shots));
  const target = path.join(run.root, partial ? 'partial' : 'latest');
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(run.dir, target);
  return target;
}

module.exports = { startRun, shotPath, failRun, promoteRun };
