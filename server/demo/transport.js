/**
 * Demo mode's stand-in for the network: answers every Azure DevOps REST call
 * this app makes, in-process, from the fictional organization in
 * server/demo/index.js. It has undici's `request` signature and response
 * shape, so `AdoClient` (and its retry, conflict and auth handling) works
 * unchanged on top of it.
 *
 * It never rejects and never answers 429 or 5xx — a bug in a handler becomes
 * a 400 recorded in `handlerErrors`, and a call nothing here answers becomes
 * a 404 recorded in `unhandled`, both visible at GET /api/demo/status.
 */

const { getState } = require('./index');
const { evaluate } = require('./wiql');
const { applyPatch } = require('./patch');
const { DEMO_ORG, DEMO_TOKENS } = require('./constants');
const { FIELD_DEFINITIONS } = require('./seed/processes');
const { WORKING_DAYS } = require('./seed/calendar');

const ORIGIN = `https://dev.azure.com/${DEMO_ORG}`;
const loggedUnhandled = new Set();

function reply(statusCode, data, headers = {}) {
  const text = data === undefined ? '' : JSON.stringify(data);
  return { statusCode, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: { text: async () => text } };
}

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

function personFor(state, headers) {
  const auth = headerValue(headers, 'authorization') || '';
  const m = /^Basic\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const token = decoded.slice(decoded.indexOf(':') + 1);
  const key = DEMO_TOKENS[token];
  return key ? state.people.find((p) => p.key === key) || null : null;
}

function projectOr404(state, segment) {
  const project = state.findProject(decodeURIComponent(segment));
  if (!project) throw fail(404, `TF200016: The following project does not exist: ${decodeURIComponent(segment)}.`);
  return project;
}

function page(list, query, defaultTop = 100) {
  const skip = Number(query.get('$skip')) || 0;
  const top = Number(query.get('$top')) || defaultTop;
  return list.slice(skip, skip + top);
}

function projectFields(fields, wanted) {
  if (!wanted || wanted.length === 0) return { ...fields };
  const out = {};
  for (const name of wanted) if (fields[name] !== undefined) out[name] = fields[name];
  return out;
}

function itemPayload(item, { fields, relations }) {
  const out = { id: item.id, rev: item.rev, fields: projectFields(item.fields, fields), url: `${ORIGIN}/_apis/wit/workItems/${item.id}` };
  if (relations) out.relations = item.relations;
  return out;
}

function changedByString(identity) {
  if (!identity) return undefined;
  if (typeof identity === 'string') return identity;
  return `${identity.displayName} <${identity.uniqueName}>`;
}

function identityRow(id, displayName, uniqueName) {
  return { localId: id, originId: id, entityId: `vss.ims.${id}`, displayName, mail: uniqueName, signInAddress: uniqueName, samAccountName: uniqueName.split('@')[0], active: true };
}

// ---------------------------------------------------------------------------
// Route handlers. `ctx` = { url, query, match, person, body, headers, state }.

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

route('GET', /^\/_apis\/connectionData$/i, ({ person }) => ({
  authenticatedUser: {
    id: person.id,
    providerDisplayName: person.displayName,
    customDisplayName: person.displayName,
    subjectDescriptor: person.descriptor,
    properties: { Account: { $type: 'System.String', $value: person.uniqueName }, DisplayName: { $type: 'System.String', $value: person.displayName } },
  },
}));

route('GET', /^\/_apis\/projects$/i, ({ state }) => ({
  count: state.projects.length,
  value: state.projects.map((p) => ({ id: p.id, name: p.name, description: p.description, state: 'wellFormed', visibility: 'private', url: `${ORIGIN}/_apis/projects/${p.id}` })),
}));

route('GET', /^\/_apis\/projects\/([^/]+)\/teams$/i, ({ state, match, query }) => {
  const project = projectOr404(state, match[1]);
  const teams = project.teams.map((t) => ({ id: t.id, name: t.name, description: `${t.name} of ${project.name}`, projectName: project.name, projectId: project.id }));
  const value = page(teams, query, 200);
  return { count: value.length, value };
});

route('GET', /^\/_apis\/projects\/([^/]+)\/teams\/([^/]+)\/members$/i, ({ state, match, query }) => {
  const project = projectOr404(state, match[1]);
  const team = project.teams.find((t) => t.id === decodeURIComponent(match[2]) || t.name === decodeURIComponent(match[2]));
  if (!team) throw fail(404, 'Team not found.');
  const members = team.members.map((p) => ({ identity: state.identityRef(p) }));
  const value = page(members, query, 100);
  return { count: value.length, value };
});

route('POST', /^\/_apis\/IdentityPicker\/Identities$/i, ({ state, body }) => {
  const q = String((body && body.query) || '').trim().toLowerCase();
  const rows = [];
  if (q) {
    for (const p of state.people) {
      const local = p.uniqueName.split('@')[0];
      if (p.displayName.toLowerCase().includes(q) || p.uniqueName.includes(q) || local === q) rows.push(identityRow(p.id, p.displayName, p.uniqueName));
      if (p.linked) {
        const legacyLocal = p.linked.uniqueName.split('@')[0];
        if (p.linked.displayName.toLowerCase().includes(q) || p.linked.uniqueName.includes(q) || legacyLocal === q) {
          rows.push(identityRow(p.linked.id, p.linked.displayName, p.linked.uniqueName));
        }
      }
    }
  }
  return { results: [{ queryToken: q, identities: rows.slice(0, 40), pagingToken: null }] };
});

route('GET', /^\/([^/]+)\/_apis\/wit\/workitemtypecategories$/i, ({ state, match }) => {
  const project = projectOr404(state, match[1]);
  return { count: project.process.categories.length, value: project.process.categories };
});

route('GET', /^\/([^/]+)\/_apis\/wit\/workitemtypes$/i, ({ state, match }) => {
  const project = projectOr404(state, match[1]);
  const { process } = project;
  const value = Object.keys(process.states).map((name) => ({
    name,
    referenceName: name.replace(/\s+/g, ''),
    states: process.states[name],
    fields: (process.fields[name] || []).map((referenceName) => ({ referenceName })),
  }));
  return { count: value.length, value };
});

route('GET', /^\/([^/]+)\/_apis\/wit\/workitemtypes\/([^/]+)\/states$/i, ({ state, match }) => {
  const project = projectOr404(state, match[1]);
  const type = decodeURIComponent(match[2]);
  const states = project.process.states[type];
  if (!states) throw fail(404, `VS402323: Work item type ${type} does not exist.`);
  return { count: states.length, value: states };
});

route('GET', /^\/([^/]+)\/_apis\/wit\/workitemtypes\/([^/]+)$/i, ({ state, match }) => {
  const project = projectOr404(state, match[1]);
  const type = decodeURIComponent(match[2]);
  if (!project.process.states[type]) throw fail(404, `VS402323: Work item type ${type} does not exist.`);
  return { name: type, fieldInstances: (project.process.fields[type] || []).map((referenceName) => ({ referenceName })) };
});

route('GET', /^\/([^/]+)\/_apis\/wit\/fields$/i, ({ state, match }) => {
  projectOr404(state, match[1]);
  return { count: FIELD_DEFINITIONS.length, value: FIELD_DEFINITIONS };
});

route('GET', /^\/([^/]+)\/_apis\/wit\/classificationnodes\/Iterations$/i, ({ state, match }) => projectOr404(state, match[1]).iterations.tree);

route('POST', /^\/([^/]+)\/_apis\/wit\/wiql$/i, ({ state, match, query, body }) => {
  projectOr404(state, match[1]);
  if (!body || typeof body.query !== 'string') throw fail(400, 'A WIQL query is required.');
  return evaluate(body.query, { items: [...state.workItems.values()], today: state.today, top: query.get('$top') });
});

route('POST', /^\/([^/]+)\/_apis\/wit\/workitemsbatch$/i, ({ state, match, body }) => {
  projectOr404(state, match[1]);
  const ids = (body && body.ids) || [];
  const expand = body && body.$expand && String(body.$expand).toLowerCase() !== 'none';
  const value = ids.map((id) => state.workItems.get(Number(id))).filter(Boolean).map((item) => itemPayload(item, { fields: body.fields, relations: expand }));
  return { count: value.length, value };
});

route('GET', /^\/([^/]+)\/_apis\/wit\/workitems\/(\d+)$/i, ({ state, match, query }) => {
  projectOr404(state, match[1]);
  const item = state.workItems.get(Number(match[2]));
  if (!item) throw fail(404, `TF401232: Work item ${match[2]} does not exist.`);
  const expand = String(query.get('$expand') || '').toLowerCase();
  const fields = query.get('fields') ? query.get('fields').split(',') : null;
  return itemPayload(item, { fields, relations: expand === 'relations' || expand === 'all' });
});

route('PATCH', /^\/([^/]+)\/_apis\/wit\/workitems\/(\d+)$/i, ({ state, match, person, body }) => {
  projectOr404(state, match[1]);
  const item = state.workItems.get(Number(match[2]));
  if (!item) throw fail(404, `TF401232: Work item ${match[2]} does not exist.`);
  const project = state.findProject(item.fields['System.TeamProject']);
  return applyPatch(item, body, state.identityRef(person), new Date(), project.process.states);
});

route('GET', /^\/([^/]+)\/_apis\/wit\/workItems\/(\d+)\/updates$/i, ({ state, match }) => {
  projectOr404(state, match[1]);
  const item = state.workItems.get(Number(match[2]));
  if (!item) throw fail(404, `TF401232: Work item ${match[2]} does not exist.`);
  const value = item.revisions.map((rev, i) => {
    const prev = i > 0 ? item.revisions[i - 1].fields : {};
    const next = item.revisions[i + 1];
    const fields = {};
    for (const [name, newValue] of Object.entries(rev.fields)) {
      if (JSON.stringify(prev[name]) !== JSON.stringify(newValue)) fields[name] = i === 0 ? { newValue } : { oldValue: prev[name], newValue };
    }
    const by = rev.fields['System.ChangedBy'] || {};
    return {
      id: i + 1,
      workItemId: item.id,
      rev: rev.rev,
      revisedBy: { id: by.id, displayName: by.displayName, uniqueName: by.uniqueName },
      revisedDate: next ? next.fields['System.ChangedDate'] : '9999-01-01T00:00:00Z',
      fields,
    };
  });
  return { count: value.length, value };
});

route('GET', /^\/([^/]+)\/_apis\/wit\/reporting\/workitemrevisions$/i, ({ state, match, query }) => {
  const project = projectOr404(state, match[1]);
  const wanted = query.get('fields') ? query.get('fields').split(',') : null;
  const start = query.get('startDateTime') ? Date.parse(query.get('startDateTime')) : 0;
  const all = [];
  for (const item of state.workItems.values()) {
    for (const rev of item.revisions) {
      if (rev.fields['System.TeamProject'] !== project.name) continue;
      if (Date.parse(rev.fields['System.ChangedDate']) < start) continue;
      all.push({ item, rev });
    }
  }
  all.sort((a, b) => Date.parse(a.rev.fields['System.ChangedDate']) - Date.parse(b.rev.fields['System.ChangedDate']) || a.item.id - b.item.id || a.rev.rev - b.rev.rev);
  const offset = Number(query.get('continuationToken')) || 0;
  const size = Math.min(Number(query.get('$top')) || 200, 200);
  const slice = all.slice(offset, offset + size);
  const values = slice.map(({ item, rev }) => {
    const fields = projectFields({ ...rev.fields, 'System.Id': item.id }, wanted);
    if (fields['System.ChangedBy']) fields['System.ChangedBy'] = changedByString(fields['System.ChangedBy']);
    return { id: item.id, rev: rev.rev, fields };
  });
  const isLastBatch = offset + size >= all.length;
  return { values, continuationToken: String(offset + slice.length), isLastBatch };
});

function teamOf(project, segment) {
  const name = decodeURIComponent(segment);
  return project.teams.find((t) => t.name === name || t.id === name) || null;
}

route('GET', /^\/([^/]+)\/([^/]+)\/_apis\/work\/teamsettings$/i, ({ state, match }) => {
  const project = projectOr404(state, match[1]);
  if (!teamOf(project, match[2])) throw fail(404, 'Team not found.');
  return { workingDays: WORKING_DAYS.slice(), bugsBehavior: 'asTasks', backlogIteration: { id: project.iterations.tree.identifier } };
});

route('GET', /^\/([^/]+)\/([^/]+)\/_apis\/work\/teamsettings\/iterations\/([^/]+)\/capacities$/i, ({ state, match }) => {
  const project = projectOr404(state, match[1]);
  const team = teamOf(project, match[2]);
  if (!team) throw fail(404, 'Team not found.');
  const entry = state.capacity[`${project.name}::${team.name}::${decodeURIComponent(match[3])}`];
  return { count: entry ? entry.value.length : 0, value: entry ? entry.value : [] };
});

route('GET', /^\/([^/]+)\/([^/]+)\/_apis\/work\/teamsettings\/iterations\/([^/]+)\/teamdaysoff$/i, ({ state, match }) => {
  const project = projectOr404(state, match[1]);
  const team = teamOf(project, match[2]);
  if (!team) throw fail(404, 'Team not found.');
  const entry = state.capacity[`${project.name}::${team.name}::${decodeURIComponent(match[3])}`];
  return { daysOff: entry ? entry.teamDaysOff : [] };
});

function publicPr(pr) {
  const { workItemIds, commits, ...rest } = pr;
  return { ...rest, url: `${ORIGIN}/${pr.repository.project.id}/_apis/git/repositories/${pr.repository.id}/pullRequests/${pr.pullRequestId}` };
}

function searchPrs(state, query, project) {
  const creator = query.get('searchCriteria.creatorId');
  const reviewer = query.get('searchCriteria.reviewerId');
  const status = (query.get('searchCriteria.status') || 'active').toLowerCase();
  const list = state.pullRequests
    .filter((pr) => !project || pr.repository.project.id === project.id)
    .filter((pr) => !creator || pr.createdBy.id === creator)
    .filter((pr) => !reviewer || pr.reviewers.some((r) => r.id === reviewer))
    .filter((pr) => status === 'all' || pr.status === status)
    .sort((a, b) => Date.parse(b.creationDate) - Date.parse(a.creationDate))
    .map(publicPr);
  const value = page(list, query, 101);
  return { count: value.length, value };
}

route('GET', /^\/_apis\/git\/pullrequests$/i, ({ state, query }) => searchPrs(state, query, null));
route('GET', /^\/([^/]+)\/_apis\/git\/pullrequests$/i, ({ state, match, query }) => searchPrs(state, query, projectOr404(state, match[1])));

function findPr(state, match) {
  const project = projectOr404(state, match[1]);
  const repoId = decodeURIComponent(match[2]);
  const pr = state.pullRequests.find((p) => p.pullRequestId === Number(match[3]) && p.repository.project.id === project.id && (p.repository.id === repoId || p.repository.name === repoId));
  if (!pr) throw fail(404, `TF401180: The requested pull request was not found.`);
  return pr;
}

route('GET', /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/workitems$/i, ({ state, match }) => {
  const pr = findPr(state, match);
  return { count: pr.workItemIds.length, value: pr.workItemIds.map((id) => ({ id: String(id), url: `${ORIGIN}/_apis/wit/workItems/${id}` })) };
});

route('GET', /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/pullRequests\/(\d+)\/commits$/i, ({ state, match }) => {
  const pr = findPr(state, match);
  return { count: pr.commits.length, value: pr.commits };
});

route('GET', /^\/([^/]+)\/_apis\/wiki\/wikis$/i, ({ state, match }) => {
  const project = projectOr404(state, match[1]);
  const wiki = state.wikis[project.name];
  return { count: wiki ? 1 : 0, value: wiki ? [{ id: wiki.id, name: wiki.name, type: 'projectWiki', projectId: project.id }] : [] };
});

function wikiPage(state, match, query) {
  const project = projectOr404(state, match[1]);
  const wiki = state.wikis[project.name];
  const name = decodeURIComponent(match[2]);
  if (!wiki || (wiki.name.toLowerCase() !== name.toLowerCase() && wiki.id !== name)) throw fail(404, `The wiki ${name} does not exist.`);
  return { wiki, path: query.get('path') || '/' };
}

route('GET', /^\/([^/]+)\/_apis\/wiki\/wikis\/([^/]+)\/pages$/i, ({ state, match, query }) => {
  const { wiki, path } = wikiPage(state, match, query);
  const page = wiki.pages[path];
  if (!page) throw fail(404, `The page '${path}' specified in the add operation doesn't exist.`);
  return { __headers: { etag: page.eTag }, body: { path, content: page.content, gitItemPath: `${path.replace(/^\//, '')}.md` } };
});

route('PUT', /^\/([^/]+)\/_apis\/wiki\/wikis\/([^/]+)\/pages$/i, ({ state, match, query, headers, body }) => {
  const { wiki, path } = wikiPage(state, match, query);
  const existing = wiki.pages[path];
  const ifMatch = headerValue(headers, 'if-match');
  if (existing && ifMatch !== existing.eTag) throw fail(412, 'The page was changed since it was read (If-Match mismatch).');
  if (!existing && ifMatch) throw fail(412, 'The page does not exist.');
  const next = existing ? `"${Number(String(existing.eTag).replace(/"/g, '')) + 1}"` : '"1"';
  wiki.pages[path] = { content: String((body && body.content) || ''), eTag: next };
  return { __headers: { etag: next }, body: { path, content: wiki.pages[path].content } };
});

// ---------------------------------------------------------------------------

async function demoRequest(url, { method = 'GET', headers = {}, body } = {}) {
  let state;
  try {
    state = getState();
    const u = new URL(url);
    if (u.host !== 'dev.azure.com' || !u.pathname.toLowerCase().startsWith(`/${DEMO_ORG}/`)) {
      state.unhandled.add(`${method} ${u.origin}${u.pathname}`);
      return reply(404, { message: `demo: unhandled ${method} ${u.origin}${u.pathname}` });
    }
    const path = u.pathname.slice(DEMO_ORG.length + 1);
    const hit = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!hit) {
      const key = `${method} ${path}`;
      state.unhandled.add(key);
      if (!loggedUnhandled.has(key)) {
        loggedUnhandled.add(key);
        // eslint-disable-next-line no-console
        console.warn(`[demo] unhandled ${key}`);
      }
      return reply(404, { message: `demo: unhandled ${key}` });
    }
    const person = personFor(state, headers);
    if (!person) return reply(401, { message: 'TF400813: The user is not authorized to access this resource.' });
    let parsed;
    if (typeof body === 'string' && body) parsed = JSON.parse(body);
    else parsed = body;
    const result = await hit.handler({ url: u, query: u.searchParams, match: path.match(hit.pattern), person, body: parsed, headers, state });
    if (result && result.__headers) return reply(200, result.body, result.__headers);
    return reply(200, result);
  } catch (err) {
    if (err && err.status >= 400 && err.status < 500) return reply(err.status, { message: err.message });
    const message = `demo handler error: ${err && err.message ? err.message : String(err)}`;
    if (state) state.handlerErrors.push(message);
    return reply(400, { message });
  }
}

module.exports = { demoRequest };
