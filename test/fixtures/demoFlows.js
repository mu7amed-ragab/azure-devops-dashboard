/**
 * Drives every data view of the app through the real HTTP routes
 * (`app.inject`) against the demo organization: sign-in for each demo token,
 * a full sync in every project, every Scrum view, cross-project hours,
 * search, pull requests, the team chart, people and per-task hours. Shared by
 * the in-process end-to-end suite and the child-process isolation suite, so
 * both exercise exactly the same calls.
 */

const PROJECTS = ['Customer Experience Portal', 'Smart Operations Platform', 'Enterprise Cloud Platform'];
const POLL_LIMIT = 600;

function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function session(app, cookieNames) {
  const jar = {};
  async function call(method, url, payload) {
    const res = await app.inject({ method, url, payload, cookies: jar });
    for (const c of res.cookies || []) {
      if (c.value === '' || (c.maxAge !== undefined && c.maxAge <= 0) || (c.expires && c.expires.getTime() < Date.now())) delete jar[c.name];
      else jar[c.name] = c.value;
    }
    let body = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch (err) {
      body = res.body;
    }
    return { status: res.statusCode, body, cookies: res.cookies || [] };
  }
  return { call, jar, cookieNames };
}

async function signIn(app, cookieNames, token, project) {
  const s = session(app, cookieNames);
  const pw = await s.call('POST', '/api/auth/password', { password: 'demo' });
  const pat = await s.call('POST', '/api/auth/pat', { pat: token });
  const projects = await s.call('GET', '/api/auth/projects');
  const pick = await s.call('POST', '/api/auth/project', { project });
  return { s, steps: { pw, pat, projects, pick } };
}

/** GETs `url` until it stops answering 202 (a sync in progress). */
async function settle(s, url, isDone = (r) => r.status !== 202) {
  let r;
  for (let i = 0; i < POLL_LIMIT; i += 1) {
    r = await s.call('GET', url);
    if (isDone(r)) return r;
    await tick();
  }
  return r;
}

async function runAllFlows({ app, config }) {
  const results = {};
  const cookieNames = config.cookieNames;

  for (const [who, token] of [['lead', 'demo-lead'], ['member', 'demo-member'], ['principal', 'demo-principal']]) {
    const { s, steps } = await signIn(app, cookieNames, token, 'Customer Experience Portal');
    results[`signin:${who}`] = steps;
    results[`me:${who}`] = await s.call('GET', '/api/auth/me');
    if (who === 'member') {
      results['member:team'] = await s.call('GET', '/api/team');
      results['member:scrum'] = await s.call('GET', '/api/scrum/sprints');
    }
  }

  const { s } = await signIn(app, cookieNames, 'demo-lead', 'Customer Experience Portal');
  for (const project of PROJECTS) {
    results[`switch:${project}`] = await s.call('POST', '/api/auth/project', { project });
    results[`dashboard:${project}`] = await settle(s, '/api/dashboard');
    results[`states:${project}`] = await s.call('GET', '/api/states');
    if (project !== 'Enterprise Cloud Platform') {
      results[`team:${project}`] = await s.call('GET', '/api/team');
      results[`scrumSprints:${project}`] = await s.call('GET', '/api/scrum/sprints');
    }
  }

  await s.call('POST', '/api/auth/project', { project: 'Customer Experience Portal' });
  const sprints = await s.call('GET', '/api/scrum/sprints');
  results.scrumSprints = sprints;
  const data = (sprints.body && sprints.body.data) || sprints.body || {};
  const current = data.currentPath || (data.sprints && data.sprints.find((x) => x.status === 'current') || {}).path;
  const q = current ? `?sprint=${encodeURIComponent(current)}` : '';
  for (const view of ['velocity', 'progress', 'utilisation', 'burndown', 'impediments', 'scope-change']) {
    results[`scrum:${view}`] = await settle(s, `/api/scrum/${view}${view === 'velocity' ? '' : q}`, (r) => r.status !== 202 && !(r.body && r.body.computing));
  }
  results['scrum:blocked-convention'] = await s.call('GET', '/api/scrum/blocked-convention');

  results.crossHours = await settle(s, '/api/hours/cross', (r) => r.status !== 200 || (r.body && r.body.status === 'ready'));
  results.search = await s.call('GET', '/api/workitems/search?q=onboarding');
  results.repos = await settle(s, '/api/pullrequests/repos');
  const repoList = (results.repos.body && results.repos.body.repos) || [];
  results.pullrequestsByRepo = {};
  for (const repo of repoList) {
    results.pullrequestsByRepo[repo.repository] = await settle(s, `/api/pullrequests?repo=${encodeURIComponent(repo.repositoryId)}`);
  }
  results.org = await s.call('GET', '/api/org');
  results.people = await s.call('GET', '/api/people');
  results.peopleSearch = await s.call('GET', '/api/people/search?q=ma');

  const dash = results['dashboard:Customer Experience Portal'].body || {};
  const taskId = findOwnTaskId(dash);
  results.taskHours = taskId ? await s.call('GET', `/api/tasks/${taskId}/hours`) : { status: 0, body: null };
  results.taskId = taskId;
  results.session = s;
  return results;
}

/** The first task or bug in the dashboard payload that carries hours. */
function findOwnTaskId(dashboard) {
  const seen = [];
  (function walk(node) {
    if (!node || typeof node !== 'object' || seen.length > 0) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node.id === 'number' && ['Task', 'Bug'].includes(node.type) && node.editable !== false) {
      seen.push(node.id);
      return;
    }
    Object.values(node).forEach(walk);
  })(dashboard);
  return seen[0] || null;
}

/** The real app (`buildApp`, as `main()` builds it) on a demo or real config. */
async function buildTestApp(config) {
  const { buildApp } = require('../../server/index');
  const { createScopeRegistry } = require('../../server/scopes');
  const { CrossHours } = require('../../server/crossHours');
  const registry = createScopeRegistry(config);
  const crossHours = new CrossHours({ registry, config, cache: registry.orgCache });
  const app = await buildApp({ config, registry, crossHours });
  await app.ready();
  async function close() {
    for (const scope of registry.list()) scope.sync.dispose();
    await app.close();
  }
  return { app, registry, crossHours, close };
}

module.exports = { runAllFlows, signIn, settle, buildTestApp, PROJECTS };
