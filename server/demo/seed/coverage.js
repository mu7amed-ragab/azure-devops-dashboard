const { isWorkingDay } = require('./calendar');
const { loggedHours } = require('./capacity');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Checks that a generated demo organization is rich enough to show every
 * feature: minimum counts, one of every situation a view exists for, and
 * dates that look current. Read-only. Returns every unmet item so a thin
 * seed fails loudly instead of rendering empty cards.
 */
function coverageReport(state) {
  const missing = [];
  const need = (ok, label) => {
    if (!ok) missing.push(label);
  };
  const items = [...state.workItems.values()];
  const lead = state.people.find((p) => p.key === 'mona');
  const legacy = state.people.find((p) => p.linked);
  const nowMs = state.now.getTime();
  const field = (i, f) => i.fields[f];
  const assignedTo = (i) => (field(i, 'System.AssignedTo') ? String(field(i, 'System.AssignedTo').uniqueName).toLowerCase() : null);
  const live = (i) => field(i, 'System.State') !== 'Removed';
  const typeOf = (i) => field(i, 'System.WorkItemType');

  // Organization shape.
  need(state.projects.length >= 3, 'at least 3 projects');
  const stateSets = new Set(state.projects.map((p) => JSON.stringify(Object.values(p.process.states).flat().map((s) => s.name).sort())));
  need(stateSets.size >= 2, 'at least 2 distinct process state sets');
  need(state.people.length >= 12, 'at least 12 people');
  need(new Set(state.people.map((p) => p.teamKey).filter(Boolean)).size >= 3, 'at least 3 teams');
  for (const role of ['lead', 'principal', 'scrum', 'developer']) need(state.people.some((p) => p.role === role), `a ${role}`);

  // The lead's workload in every project.
  for (const project of state.projects) {
    const mine = items.filter((i) => field(i, 'System.TeamProject') === project.name && live(i) && assignedTo(i) === lead.uniqueName);
    if (project.name === state.defaultProject) {
      need(mine.length >= 25, `lead has 25+ items in ${project.name} (has ${mine.length})`);
      need(new Set(mine.map((i) => field(i, 'System.IterationPath'))).size >= 5, `lead's items span 5+ iterations in ${project.name}`);
    } else {
      need(mine.length >= 8, `lead has 8+ items in ${project.name} (has ${mine.length})`);
    }
  }

  // Work item variety.
  for (const type of ['Feature', 'Epic', 'Spike', 'Impediment']) need(items.some((i) => typeOf(i) === type), `a ${type}`);
  const spikes = items.filter((i) => typeOf(i) === 'Spike');
  need(spikes.some((i) => field(i, 'System.Parent')) && spikes.some((i) => !field(i, 'System.Parent')), 'a Spike under a story and one on its own');
  const categoriesSeen = new Set();
  for (const i of items) {
    const project = state.projects.find((p) => p.name === field(i, 'System.TeamProject'));
    const st = (project.process.states[typeOf(i)] || []).find((s) => s.name === field(i, 'System.State'));
    if (st) categoriesSeen.add(st.category);
  }
  for (const cat of ['Proposed', 'InProgress', 'Resolved', 'Completed', 'Removed']) need(categoriesSeen.has(cat), `an item in the ${cat} category`);

  const parentOf = (i) => field(i, 'System.Parent') && state.workItems.get(field(i, 'System.Parent'));
  need(
    items.some((i) => {
      const p = parentOf(i);
      return p && ['Task', 'Bug'].includes(typeOf(i)) && field(i, 'System.IterationPath') !== field(p, 'System.IterationPath') && typeOf(p) !== 'Feature';
    }),
    'a cross-sprint child'
  );
  need(items.some((i) => state.projects.some((p) => p.name === field(i, 'System.IterationPath')) && ['Task', 'Bug'].includes(typeOf(i))), 'a no-sprint item');

  // Blocked and stalled, in the current sprint of the default project.
  const tags = (i) => String(field(i, 'System.Tags') || '').toLowerCase();
  need(items.some((i) => tags(i).split(';').map((t) => t.trim()).includes('blocked')), 'an item blocked by tag');
  need(items.some((i) => field(i, 'Microsoft.VSTS.CMMI.Blocked') === 'Yes'), 'an item blocked by field');
  need(items.some((i) => typeOf(i) === 'Impediment' && field(i, 'System.State') === 'Open'), 'an item blocked by state');
  need(
    items.some((i) => {
      const changed = Date.parse(field(i, 'System.ChangedDate'));
      return ['Active', 'In Progress'].includes(field(i, 'System.State')) && nowMs - changed > 5 * DAY_MS;
    }),
    'a stalled item'
  );

  // Re-estimates, scope change, ownership history.
  const estimateHistory = (i, f) => i.revisions.map((r) => r.fields[f]).filter((v) => v != null);
  const estFields = ['Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort'];
  const reestimates = items.flatMap((i) =>
    estFields.map((f) => {
      const h = estimateHistory(i, f);
      return h.length >= 2 ? h[h.length - 1] - h[0] : 0;
    })
  );
  need(reestimates.some((d) => d > 0), 'a story re-estimated up');
  need(reestimates.some((d) => d < 0), 'a story re-estimated down');
  const iterationMoves = items.filter((i) => new Set(i.revisions.map((r) => r.fields['System.IterationPath'])).size > 1);
  need(iterationMoves.length >= 2, 'items moved into and out of a sprint');
  const formerlyLead = items.filter((i) => live(i) && assignedTo(i) !== lead.uniqueName && i.revisions.some((r) => r.fields['System.AssignedTo'] && r.fields['System.AssignedTo'].uniqueName === lead.uniqueName));
  need(formerlyLead.length > 0, 'an item formerly assigned to the lead');
  need(formerlyLead.some((i) => /onboarding/i.test(field(i, 'System.Title'))), 'a formerly-lead item titled with "onboarding"');
  need(legacy && items.some((i) => assignedTo(i) === legacy.linked.uniqueName.toLowerCase()), 'an item assigned to the linked legacy identity');
  need(items.filter((i) => nowMs - Date.parse(field(i, 'System.ChangedDate')) <= 3 * DAY_MS).length >= 3, '3+ items changed in the last 3 days');

  // Hours.
  const hourRevs = [];
  for (const i of items) {
    let prev = 0;
    for (const r of i.revisions) {
      const c = Number(r.fields['Microsoft.VSTS.Scheduling.CompletedWork']) || 0;
      if (c > prev) hourRevs.push({ at: new Date(r.fields['System.ChangedDate']), project: field(i, 'System.TeamProject') });
      prev = c;
    }
  }
  need(hourRevs.every((h) => isWorkingDay(h.at)), 'hours logged only Sunday–Thursday');
  if (hourRevs.length > 0) {
    const span = Math.max(...hourRevs.map((h) => h.at.getTime())) - Math.min(...hourRevs.map((h) => h.at.getTime()));
    need(span >= 8 * 7 * DAY_MS, 'hours spanning 8+ weeks');
  }
  need(new Set(hourRevs.map((h) => h.project)).size >= 2, 'hours in 2+ projects');
  const leadHoursProjects = new Set();
  for (const i of items) {
    for (let k = 1; k < i.revisions.length; k += 1) {
      const r = i.revisions[k];
      if (String(r.fields['System.ChangedBy'].uniqueName).toLowerCase() !== lead.uniqueName) continue;
      if ((Number(r.fields['Microsoft.VSTS.Scheduling.CompletedWork']) || 0) > (Number(i.revisions[k - 1].fields['Microsoft.VSTS.Scheduling.CompletedWork']) || 0)) {
        leadHoursProjects.add(field(i, 'System.TeamProject'));
      }
    }
  }
  need(leadHoursProjects.size >= 2, "the lead's hours span 2+ projects");

  // Pull requests.
  need(state.pullRequests.length >= 30, `30+ pull requests (has ${state.pullRequests.length})`);
  need(new Set(state.pullRequests.map((p) => p.repository.id)).size >= 4, 'PRs in 4+ repositories');
  need(new Set(state.pullRequests.map((p) => p.repository.project.name)).size >= 2, 'PRs in 2+ projects');
  for (const status of ['active', 'completed', 'abandoned']) need(state.pullRequests.some((p) => p.status === status), `a ${status} PR`);
  need(
    state.pullRequests.some((p) => p.workItemIds.some((id) => state.workItems.get(id) && field(state.workItems.get(id), 'System.TeamProject') !== p.repository.project.name)),
    'a PR linking a work item from another project'
  );
  need(state.pullRequests.filter((p) => p.createdBy.id === lead.id).length >= 10, 'lead authored 10+ PRs');

  // Capacity spread in the current sprint of the default project.
  const atlas = state.projects.find((p) => p.name === state.defaultProject);
  const current = atlas.iterations.flat.find((s) => s.start <= state.today && state.today <= s.finish);
  if (current) {
    const rows = (state.capacity[`${atlas.name}::${atlas.teams[0].name}::${current.identifier}`] || {}).value || [];
    need(rows.length > 0, 'capacity rows for the current sprint');
    const logged = loggedHours(items.filter((i) => field(i, 'System.TeamProject') === atlas.name), current.start, state.today);
    need(rows.some((r) => (logged.get(r.teamMember.uniqueName.toLowerCase()) || 0) > 0), 'someone logged hours in the current sprint');
  }

  // Charts and dates.
  for (const name of ['Customer Experience Portal', 'Smart Operations Platform']) {
    const wiki = state.wikis[name];
    need(wiki && /"email": "mona\.ahmed@masar\.dev"[\s\S]*?"role": "lead"/.test(Object.values(wiki.pages)[0].content), `lead role in the ${name} chart`);
  }
  need(items.every((i) => Date.parse(field(i, 'System.ChangedDate')) <= nowMs), 'no change dated in the future');

  // State and progress agree: a New item has no hours, an Active one is part-way, a finished one has
  // nothing left. A story is judged by the hours of the tasks and bugs under it.
  const categoryOf = (i) => {
    const project = state.projects.find((p) => p.name === field(i, 'System.TeamProject'));
    const hit = ((project && project.process.states[typeOf(i)]) || []).find((x) => x.name === field(i, 'System.State'));
    return hit ? hit.category : null;
  };
  const num = (i, f) => Number(field(i, f)) || 0;
  const kidsOf = new Map();
  for (const i of items) {
    const parent = field(i, 'System.Parent');
    if (parent) kidsOf.set(parent, [...(kidsOf.get(parent) || []), i]);
  }
  const contradictions = [];
  for (const i of items) {
    const cat = categoryOf(i);
    if (!cat || cat === 'Removed') continue;
    const hasHours = field(i, 'Microsoft.VSTS.Scheduling.OriginalEstimate') !== undefined;
    const kids = (kidsOf.get(i.id) || []).filter((k) => categoryOf(k) !== 'Removed' && field(k, 'Microsoft.VSTS.Scheduling.OriginalEstimate') !== undefined);
    let done;
    let left;
    if (hasHours) {
      done = num(i, 'Microsoft.VSTS.Scheduling.CompletedWork');
      left = num(i, 'Microsoft.VSTS.Scheduling.RemainingWork');
    } else if (kids.length > 0 && ['User Story', 'Product Backlog Item'].includes(typeOf(i))) {
      done = kids.reduce((n, k) => n + num(k, 'Microsoft.VSTS.Scheduling.CompletedWork'), 0);
      left = kids.reduce((n, k) => n + num(k, 'Microsoft.VSTS.Scheduling.RemainingWork'), 0);
    } else continue;
    const bad =
      (cat === 'Proposed' && done > 0) ||
      (cat === 'InProgress' && (done <= 0 || (!hasHours && left <= 0))) ||
      ((cat === 'Resolved' || cat === 'Completed') && left > 0);
    if (bad) contradictions.push(`#${i.id} ${typeOf(i)} ${field(i, 'System.State')} ${done}h done/${left}h left`);
  }
  if (process.env.DEMO_DEBUG) console.error(contradictions);
  need(contradictions.length === 0, `state and progress agree (${contradictions.slice(0, 4).join('; ')}${contradictions.length > 4 ? `; +${contradictions.length - 4} more` : ''})`);

  // On each person's page an active story is part-way: the tasks that person holds under it are neither
  // untouched nor finished.
  const awkward = [];
  for (const i of items) {
    if (categoryOf(i) !== 'InProgress' || !['User Story', 'Product Backlog Item'].includes(typeOf(i))) continue;
    const kids = (kidsOf.get(i.id) || []).filter((k) => categoryOf(k) !== 'Removed' && field(k, 'Microsoft.VSTS.Scheduling.OriginalEstimate') !== undefined);
    const groups = new Map();
    for (const k of kids) {
      const who = assignedTo(k);
      const g = groups.get(who) || { done: 0, left: 0 };
      g.done += num(k, 'Microsoft.VSTS.Scheduling.CompletedWork');
      g.left += num(k, 'Microsoft.VSTS.Scheduling.RemainingWork');
      groups.set(who, g);
    }
    for (const [who, g] of groups) if (g.done <= 0 || g.left <= 0) awkward.push(`#${i.id} ${who}`);
  }
  need(awkward.length === 0, `an active story is part-way for everyone who holds tasks under it (${awkward.slice(0, 3).join('; ')})`);

  // The lead's hours this week look like a real week: 5-8 a day, 30-38 in all.
  const thisWeek = [];
  for (let d = new Date(state.today.getFullYear(), state.today.getMonth(), state.today.getDate() - state.today.getDay()); d <= state.today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (isWorkingDay(d)) thisWeek.push(d);
  }
  const dayHours = thisWeek.map((d) => loggedHours(items, d, d).get(lead.uniqueName.toLowerCase()) || 0);
  need(dayHours.every((h) => h >= 5 && h <= 8), `the lead logs 5-8 hours each working day this week (${dayHours.join(', ')})`);
  if (thisWeek.length === 5) {
    const total = dayHours.reduce((a, b) => a + b, 0);
    need(total >= 30 && total <= 38, `the lead's week totals 30-38 hours (${total})`);
  }

  // Everyone on a project's roster has logged something in its current sprint.
  for (const project of state.projects) {
    const sprint = project.iterations.flat.find((x) => x.start <= state.today && state.today <= x.finish);
    if (!sprint) continue;
    const projectItems = items.filter((i) => field(i, 'System.TeamProject') === project.name);
    const logged = loggedHours(projectItems, sprint.start, state.today);
    const idle = state.people.filter((p) => p.projects.includes(project.name) && !(logged.get(p.uniqueName.toLowerCase()) > 0));
    need(idle.length === 0, `every ${project.name} member logged hours this sprint (${idle.map((p) => p.key).join(', ')})`);
  }

  return { ok: missing.length === 0, missing };
}

module.exports = { coverageReport };
