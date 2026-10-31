const { addDays, addWorkingDays, workingDaysBetween, weekStart, isWorkingDay, at } = require('./calendar');
const { identityRef } = require('./people');
const { BACKLOG, TASK_TEMPLATES, BUG_TITLES, SPIKE_TITLES, TAGS } = require('./vocabulary');
const { stateIn } = require('./processes');
const { loggedHours } = require('./capacity');

const HOUR_STEPS = [1, 1.5, 2, 2, 2.5, 3, 3, 4, 4, 5, 6];
const TASK_ESTIMATES = [4, 6, 6, 8, 8, 10, 12, 16];
const POINTS = [1, 2, 3, 3, 5, 5, 8, 8, 13];

// The most hours one person logs on each working day (Sunday..Thursday), over every project they work in.
const DAY_CAPS = [7.5, 7, 7.5, 6.5, 7];

// Story counts per sprint (oldest first) for each project's backlog.
const STORIES_PER_SPRINT = {
  'Customer Experience Portal': [4, 4, 4, 4, 4, 4],
  'Smart Operations Platform': [3, 3, 3, 3, 3, 3],
  'Enterprise Cloud Platform': [3, 2, 2, 3, 2, 2],
};
// Which team builds each epic, by project and epic index.
const EPIC_TEAMS = {
  'Customer Experience Portal': ['apps', 'ux'],
  'Smart Operations Platform': ['ops', 'ops'],
  'Enterprise Cloud Platform': ['infra', 'infra'],
};
// Sprints (by index) in which the lead owns a story in each project.
const LEAD_STORY_SPRINTS = {
  'Customer Experience Portal': [0, 1, 2, 3, 4, 5],
  'Smart Operations Platform': [2, 3, 4, 5],
  'Enterprise Cloud Platform': [2, 3, 4, 5],
};

/**
 * Generates one project's work items as full revision histories: every item
 * is created, assigned, started, has hours logged day by day on working days,
 * and is resolved or closed — so the revision index, burndown, velocity and
 * scope-change views all have real history to read. Current fields are the
 * last revision's.
 *
 * Also plants, by name, every situation the dashboard has a view for
 * (cross-sprint child, blocked and stalled items, re-estimates, scope
 * changes, past ownership, a linked identity) — see plant* below.
 */
function buildWorkItems({ rng, project, proc, people, iterations, now, nextId, load = new Map() }) {
  const nowMs = now.getTime();
  const byKey = new Map(people.map((p) => [p.key, p]));
  const lead = byKey.get('mona');
  const sprintsByIndex = iterations.flat;
  const currentIndex = sprintsByIndex.findIndex((s) => s.start <= now && now <= addDays(s.finish, 3));
  const current = sprintsByIndex[currentIndex >= 0 ? currentIndex : 4];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const items = [];
  const reqType = proc.requirementType;

  const teamPeople = (teamKey) =>
    people.filter((p) => p.projects.includes(project) && (p.teamKey === teamKey || p.key === 'mona') && p.role !== 'scrum' && p.key !== 'abdullah');

  // ----- revision recording ----------------------------------------------

  function clampIso(date) {
    let ms = date.getTime();
    if (ms > nowMs - 60000) ms = nowMs - rng.int(2, 50) * 60000;
    return new Date(ms);
  }

  function stamp(item, when) {
    let d = clampIso(new Date(when));
    if (item && item._lastMs && d.getTime() <= item._lastMs) {
      const bumped = item._lastMs + rng.int(1, 9) * 60000;
      d = new Date(bumped < nowMs ? bumped : Math.min(nowMs, item._lastMs + 1));
    }
    return d;
  }

  function create(type, title, fields, when, by) {
    const id = nextId();
    const d = stamp(null, when);
    const f = {
      'System.Id': id,
      'System.TeamProject': project,
      'System.AreaPath': project,
      'System.WorkItemType': type,
      'System.Title': title,
      'System.State': stateIn(proc, type, 'Proposed') || 'New',
      'System.Tags': '',
      'System.CreatedDate': d.toISOString(),
      'System.CreatedBy': identityRef(by),
      'System.ChangedDate': d.toISOString(),
      'System.ChangedBy': identityRef(by),
      ...fields,
    };
    const item = { id, rev: 1, fields: f, relations: [], revisions: [{ rev: 1, fields: { ...f } }], _lastMs: d.getTime() };
    items.push(item);
    return item;
  }

  function change(item, when, by, patch) {
    const d = stamp(item, when);
    item.rev += 1;
    item.fields = { ...item.fields, ...patch, 'System.ChangedDate': d.toISOString(), 'System.ChangedBy': identityRef(by) };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete item.fields[k];
    item.revisions.push({ rev: item.rev, fields: { ...item.fields } });
    item._lastMs = d.getTime();
    return item;
  }

  function link(parent, child, when, by) {
    parent.relations.push({ rel: 'System.LinkTypes.Hierarchy-Forward', url: `https://dev.azure.com/masar/_apis/wit/workItems/${child.id}`, attributes: { isLocked: false, name: 'Child' } });
    child.relations.push({ rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/masar/_apis/wit/workItems/${parent.id}`, attributes: { isLocked: false, name: 'Parent' } });
    if (child.revisions.length === 1 && child.fields['System.Parent'] === undefined) {
      child.fields['System.Parent'] = parent.id;
      child.revisions[0].fields['System.Parent'] = parent.id;
    } else {
      change(child, when, by, { 'System.Parent': parent.id });
    }
  }

  const stateOf = (type, cat, nth) => stateIn(proc, type, cat, nth);
  const assign = (person) => identityRef(person);

  // ----- hours simulation --------------------------------------------------

  // Nobody logs more than that day's cap (6.5-7.5 hours), across every project they work in.
  const dayKey = (person, day) => `${String(person.uniqueName).toLowerCase()}|${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
  // The lead's planned hours for this week are held back from everything else until each project's
  // own task claims its share, so no project can crowd the others out of the week.
  const reserveKey = (day) => `reserve|${lead.uniqueName.toLowerCase()}|${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
  const roomOn = (person, day) => Math.max(0, (DAY_CAPS[day.getDay()] || 0) - (load.get(dayKey(person, day)) || 0) - (person === lead ? load.get(reserveKey(day)) || 0 : 0));

  /** One logged-hours revision: completed goes up, remaining down, state follows. */
  function logHours(task, when, person, day, hours) {
    const remaining = Number(task.fields['Microsoft.VSTS.Scheduling.RemainingWork']) || 0;
    const completed = (Number(task.fields['Microsoft.VSTS.Scheduling.CompletedWork']) || 0) + hours;
    const left = Math.max(0, remaining - hours);
    const patch = {
      'Microsoft.VSTS.Scheduling.CompletedWork': completed,
      'Microsoft.VSTS.Scheduling.RemainingWork': left,
    };
    const type = task.fields['System.WorkItemType'];
    const cat = categoryOf(type, task.fields['System.State']);
    if (cat === 'Proposed') patch['System.State'] = stateOf(type, 'InProgress');
    if (left === 0) patch['System.State'] = stateOf(type, 'Completed');
    change(task, when, person, patch);
    load.set(dayKey(person, day), (load.get(dayKey(person, day)) || 0) + hours);
    return patch;
  }

  /** Logs hours on `task` over the given working days; returns whether it finished.
   * `daily` logs about that many hours each chosen day instead of the usual 1-6.
   * The hours are planned first, so a task that has to finish by the end of its
   * sprint spreads its remainder over earlier days with room instead of dumping
   * it on the last one. */
  function work(task, days, person, { chance = 0.6, finish = false, story = null, daily = null } = {}) {
    let remaining = Number(task.fields['Microsoft.VSTS.Scheduling.RemainingWork']) || 0;
    const room = days.map((day) => roomOn(person, day));
    const plan = new Array(days.length).fill(0);
    for (let i = 0; i < days.length && remaining > 0; i += 1) {
      // A task that has to be finished by the end of its sprint is worked every day of the last three.
      const pressing = finish && i >= days.length - 3;
      if (!pressing && !rng.chance(chance)) continue;
      let hours = daily ? Math.max(1, daily + rng.pick([-1, -0.5, 0, 0.5, 1])) : rng.pick(HOUR_STEPS);
      if (pressing) hours = Math.max(hours, Math.ceil((remaining / (days.length - i)) * 2) / 2);
      hours = Math.min(remaining, Math.round(hours * 2) / 2, room[i]);
      if (hours <= 0) continue;
      plan[i] = hours;
      room[i] -= hours;
      remaining -= hours;
    }
    if (finish && remaining > 0) {
      for (let i = days.length - 1; i >= 0 && remaining > 0; i -= 1) {
        const extra = Math.min(remaining, room[i]);
        if (extra <= 0) continue;
        plan[i] += extra;
        room[i] -= extra;
        remaining -= extra;
      }
      if (remaining > 0 && days.length > 0) plan[days.length - 1] += remaining;
    }
    let done = false;
    for (let i = 0; i < days.length; i += 1) {
      if (plan[i] <= 0) continue;
      const day = days[i];
      const when = at(day, rng.int(10, 17), rng.int(0, 59));
      // Hours are never logged later than now, nor moved onto a weekend by clamping.
      if (Date.parse(when) > nowMs - 60000) break;
      const patch = logHours(task, when, person, day, plan[i]);
      // The story starts with its first logged hours, even when that one log finishes the task.
      if (story) startStory(story, day, person);
      if (patch['Microsoft.VSTS.Scheduling.RemainingWork'] === 0) {
        done = true;
        break;
      }
    }
    return done;
  }

  function categoryOf(type, state) {
    const list = proc.states[type] || [];
    const hit = list.find((s) => s.name === state);
    return hit ? hit.category : null;
  }

  function startStory(story, day, person) {
    const type = story.fields['System.WorkItemType'];
    if (categoryOf(type, story.fields['System.State']) === 'Proposed') {
      change(story, at(day, 9, rng.int(0, 30)), person, { 'System.State': stateOf(type, 'InProgress') });
    }
  }

  function finishStory(story, day, person, { resolveOnly = false } = {}) {
    const type = story.fields['System.WorkItemType'];
    const resolved = stateOf(type, 'Resolved');
    if (resolved) change(story, at(day, 17, rng.int(0, 50)), person, { 'System.State': resolved });
    if (!resolveOnly || !resolved) change(story, at(addWorkingDays(day, 1), 10, rng.int(0, 50)), person, { 'System.State': stateOf(type, 'Completed') });
  }

  // ----- epics and features ------------------------------------------------

  const backlog = BACKLOG[project];
  const epicCreated = at(addDays(sprintsByIndex[0].start, -21), 10);
  const features = [];
  backlog.forEach((epicDef, e) => {
    const teamKey = EPIC_TEAMS[project][e];
    const owner = e === 0 && project === 'Customer Experience Portal' ? lead : teamPeople(teamKey).find((p) => p.role === 'lead') || lead;
    const epic = create(proc.epicType, epicDef.epic, { 'System.AssignedTo': assign(owner), 'System.IterationPath': project }, epicCreated, byKey.get('abdullah'));
    change(epic, at(sprintsByIndex[0].start, 11), owner, { 'System.State': stateOf(proc.epicType, 'InProgress') });
    epicDef.features.forEach((featureDef, f) => {
      const fOwner = e === 0 && f === 0 && project === 'Customer Experience Portal' ? lead : owner;
      const feature = create(proc.featureType, featureDef.name, { 'System.AssignedTo': assign(fOwner), 'System.IterationPath': project }, at(addDays(sprintsByIndex[0].start, -14), 11), owner);
      link(epic, feature, at(addDays(sprintsByIndex[0].start, -14), 12), owner);
      change(feature, at(sprintsByIndex[0].start, 14), fOwner, { 'System.State': stateOf(proc.featureType, 'InProgress') });
      features.push({ item: feature, teamKey, stories: featureDef.stories.slice(), epic: e });
    });
  });

  plantThisWeeksHours({ project, proc, lead, current, today, create, logHours, assign, features, link, load, reserveKey });

  // ----- stories and tasks, sprint by sprint ------------------------------

  const storyPlan = [];
  let featureCursor = 0;
  STORIES_PER_SPRINT[project].forEach((count, sprintIndex) => {
    for (let n = 0; n < count; n += 1) {
      let tries = 0;
      while (features[featureCursor % features.length].stories.length === 0 && tries < features.length) {
        featureCursor += 1;
        tries += 1;
      }
      const feature = features[featureCursor % features.length];
      featureCursor += 1;
      const title = feature.stories.shift();
      if (!title) continue;
      storyPlan.push({ sprintIndex, feature, title });
    }
  });

  const leadSprints = new Set(LEAD_STORY_SPRINTS[project]);
  const leadTaken = new Set();
  const stories = [];

  for (const plan of storyPlan) {
    const sprint = sprintsByIndex[plan.sprintIndex];
    const team = teamPeople(plan.feature.teamKey);
    let owner;
    if (leadSprints.has(plan.sprintIndex) && !leadTaken.has(plan.sprintIndex) && (plan.feature.teamKey === 'apps' || project !== 'Customer Experience Portal')) {
      owner = lead;
      leadTaken.add(plan.sprintIndex);
    } else {
      owner = rng.pick(team.filter((p) => p.key !== 'mona')) || lead;
    }
    const creator = team.find((p) => p.role === 'lead') || lead;
    const createdOn = addWorkingDays(sprint.start, -rng.int(2, 7));
    const estimate = rng.pick(POINTS);
    const tags = rng.chance(0.5) ? rng.pick(TAGS) : '';
    const story = create(reqType, plan.title, {
      'System.AssignedTo': assign(owner),
      'System.IterationPath': sprint.path,
      'System.Tags': tags,
      [proc.estimateField]: estimate,
    }, at(createdOn, 10, rng.int(0, 59)), creator);
    link(plan.feature.item, story, at(createdOn, 11), creator);
    if (proc.key === 'scrum') change(story, at(addWorkingDays(sprint.start, -1), 15), creator, { 'System.State': stateOf(reqType, 'Proposed', 1) });

    const taskCount = rng.int(2, 4);
    const tasks = [];
    for (let t = 0; t < taskCount; t += 1) {
      const assignee = owner === lead ? (rng.chance(0.4) ? lead : rng.pick(team)) : rng.chance(0.6) ? owner : rng.pick(team);
      const est = rng.pick(TASK_ESTIMATES);
      const task = create(proc.taskType, TASK_TEMPLATES[(t + plan.title.length) % TASK_TEMPLATES.length].replace('{s}', lowerFirst(plan.title)), {
        'System.AssignedTo': assign(assignee),
        'System.IterationPath': sprint.path,
        'Microsoft.VSTS.Scheduling.OriginalEstimate': est,
        'Microsoft.VSTS.Scheduling.RemainingWork': est,
        'Microsoft.VSTS.Scheduling.CompletedWork': 0,
        ...(proc.blockedField && proc.taskType === 'Task' ? { [proc.blockedField]: 'No' } : {}),
      }, at(sprint.start, 9, rng.int(0, 59)), owner);
      link(story, task, at(sprint.start, 9, 30), owner);
      tasks.push({ task, assignee });
    }
    if (rng.chance(0.3)) {
      const assignee = rng.pick(team);
      const est = rng.pick([2, 4, 6]);
      const bug = create(proc.bugType, rng.pick(BUG_TITLES), {
        'System.AssignedTo': assign(assignee),
        'System.IterationPath': sprint.path,
        'Microsoft.VSTS.Scheduling.OriginalEstimate': est,
        'Microsoft.VSTS.Scheduling.RemainingWork': est,
        'Microsoft.VSTS.Scheduling.CompletedWork': 0,
        ...(proc.key === 'scrum' ? { 'Microsoft.VSTS.Scheduling.Effort': 2 } : { 'Microsoft.VSTS.Scheduling.StoryPoints': 1 }),
      }, at(addWorkingDays(sprint.start, 2), 11), owner);
      link(story, bug, at(addWorkingDays(sprint.start, 2), 11, 30), owner);
      tasks.push({ task: bug, assignee });
    }
    stories.push({ story, tasks, sprint, owner, team });
  }

  // Simulate each story's sprint.
  for (const s of stories) {
    const { sprint } = s;
    if (sprint.start > today) continue; // future sprint: planned, not started
    const isPast = sprint.finish < today;
    const days = workingDaysBetween(sprint.start, isPast ? sprint.finish : today);
    let allDone = true;
    for (const { task, assignee } of s.tasks) {
      const done = work(task, days, assignee, { chance: isPast ? 0.55 : 0.5, finish: isPast, story: s.story });
      if (!done) allDone = false;
    }
    if (allDone && s.tasks.length > 0) {
      const lastMs = Math.max(...s.tasks.map((t) => t.task._lastMs));
      const lastDay = new Date(lastMs);
      // Current-sprint stories stop at Resolved where the workflow has it.
      finishStory(s.story, new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate()), s.owner, { resolveOnly: !isPast });
    }
  }

  // ----- the situations every view needs (one helper each) ---------------

  const ctx = { rng, project, proc, people, byKey, lead, sprintsByIndex, current, today, items, stories, features, create, change, link, work, logHours, roomOn, assign, stateOf, categoryOf, finishStory, teamPeople };
  plantUnparentedAndNoSprint(ctx);
  plantCrossSprintChild(ctx);
  plantScopeChanges(ctx);
  plantBlockedAndStalled(ctx);
  plantReestimates(ctx);
  plantPastOwnership(ctx);
  plantLinkedIdentity(ctx);
  plantRemoved(ctx);
  if (proc.spikeType) plantSpikes(ctx);
  plantRosterHours(ctx);
  plantRecentActivity(ctx);
  reconcileActiveStories(ctx);

  for (const item of items) delete item._lastMs;
  return items;
}

function lowerFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function hoursFields(est) {
  return {
    'Microsoft.VSTS.Scheduling.OriginalEstimate': est,
    'Microsoft.VSTS.Scheduling.RemainingWork': est,
    'Microsoft.VSTS.Scheduling.CompletedWork': 0,
  };
}

/** Bugs and tasks with no parent story, and two items with no sprint at all. */
function plantUnparentedAndNoSprint({ rng, project, proc, lead, current, sprintsByIndex, today, create, change, work, assign, teamPeople }) {
  const team = teamPeople(project === 'Customer Experience Portal' ? 'apps' : project === 'Smart Operations Platform' ? 'ops' : 'infra');
  const titles = BUG_TITLES.slice(rng.int(0, 3));
  for (let i = 0; i < 4; i += 1) {
    const sprint = i < 2 ? current : sprintsByIndex[current.index - 1];
    const person = i % 2 === 0 ? lead : rng.pick(team);
    const est = rng.pick([3, 4, 6]);
    const bug = create(proc.bugType, titles[i % titles.length], { 'System.AssignedTo': assign(person), 'System.IterationPath': sprint.path, ...hoursFields(est), 'System.Tags': 'customer-reported' }, at(addWorkingDays(sprint.start, 1), 10), person);
    if (sprint.start <= today) work(bug, workingDaysBetween(sprint.start, sprint.finish < today ? sprint.finish : today), person, { chance: 0.4, finish: sprint.finish < today });
  }
  // A fixed bug waiting for verification, where the workflow has that step.
  const resolved = stateIn(proc, proc.bugType, 'Resolved');
  const previous = sprintsByIndex[current.index - 1];
  if (resolved && previous) {
    const person = rng.pick(team);
    const bug = create(proc.bugType, '[Bug] تاريخ التسليم يظهر بتوقيت خاطئ في Order Confirmation', { 'System.AssignedTo': assign(person), 'System.IterationPath': previous.path, ...hoursFields(3) }, at(addWorkingDays(previous.start, 2), 10), person);
    const days = workingDaysBetween(addWorkingDays(previous.start, 3), previous.finish);
    work(bug, days.slice(0, 2), person, { chance: 1 });
    const left = Number(bug.fields['Microsoft.VSTS.Scheduling.RemainingWork']) || 0;
    const done = Number(bug.fields['Microsoft.VSTS.Scheduling.CompletedWork']) || 0;
    const finishDay = days[Math.min(3, days.length - 1)];
    change(bug, at(finishDay, 16), person, {
      'System.State': resolved,
      'Microsoft.VSTS.Scheduling.CompletedWork': done + left,
      'Microsoft.VSTS.Scheduling.RemainingWork': 0,
    });
  }
  const noSprintTitles = project === 'Smart Operations Platform' ? ['مراجعة أسباب الـ Crashes المتكررة في Background Workers', 'توحيد أسماء الـ Metrics في لوحات المراقبة'] : ['مراجعة الـ Feature Flags غير المستخدمة', 'تجميع ملاحظات Onboarding من تذاكر الدعم'];
  for (const title of noSprintTitles) {
    create(proc.taskType, title, { 'System.AssignedTo': assign(lead), 'System.IterationPath': project, ...hoursFields(4) }, at(addWorkingDays(current.start, -3), 15), lead);
  }
}

/** A task moved out to the next sprint while its story stays in this one. */
function plantCrossSprintChild({ rng, sprintsByIndex, current, lead, stories, change }) {
  const next = sprintsByIndex[current.index + 1];
  if (!next) return;
  const s = stories.find((x) => x.sprint === current && x.owner === lead) || stories.find((x) => x.sprint === current);
  if (!s) return;
  const open = s.tasks.find(({ task }) => Number(task.fields['Microsoft.VSTS.Scheduling.RemainingWork']) > 0);
  if (!open) return;
  change(open.task, at(addWorkingDays(current.start, 2), 16, rng.int(0, 59)), lead, { 'System.IterationPath': next.path });
}

// Hours the lead logs on Sunday..Thursday of the current week, split across her three projects.
const WEEK_TARGETS = [6, 6.5, 7, 6, 6.5];
const PROJECT_SHARE = { 'Customer Experience Portal': 0.7, 'Smart Operations Platform': 0.2, 'Enterprise Cloud Platform': 0.1 };

/** One long task the lead works on every day of the current week, so the hours
 * card shows a believable week (5-8 hours a day) however the rest of the sprint went. */
function plantThisWeeksHours({ project, proc, lead, current, today, create, logHours, assign, features, link, load, reserveKey }) {
  const start = weekStart(today) > current.start ? weekStart(today) : current.start;
  const days = workingDaysBetween(start, today);
  if (days.length === 0) return;
  for (const day of days) if (!load.has(reserveKey(day))) load.set(reserveKey(day), WEEK_TARGETS[day.getDay()] || 0);
  const titles = { 'Customer Experience Portal': 'تحسين رسائل الخطأ في Registration Form', 'Smart Operations Platform': 'تحسين أداء Caching لاستعلامات لوحة العمليات', 'Enterprise Cloud Platform': 'تحسين Rollback Scripts في الـ Pipeline' };
  const task = create(proc.taskType, titles[project] || 'تحسين Error Handling', { 'System.AssignedTo': assign(lead), 'System.IterationPath': current.path, ...hoursFields(40) }, at(addWorkingDays(start, -1), 16), lead);
  if (features && features[0]) link(features[0].item, task, at(addWorkingDays(start, -1), 16, 5), lead);
  for (const day of days) {
    const want = Math.max(1, Math.round(WEEK_TARGETS[day.getDay()] * (PROJECT_SHARE[project] || 0.3) * 2) / 2);
    load.set(reserveKey(day), (load.get(reserveKey(day)) || 0) - want);
    logHours(task, at(day, 15, 10), lead, day, want);
  }
}

/** Scope change: an item pulled into the current sprint, another pushed out. */
function plantScopeChanges({ rng, proc, project, sprintsByIndex, current, lead, features, create, change, link, assign, teamPeople }) {
  const next = sprintsByIndex[current.index + 1];
  const team = teamPeople(features[0].teamKey);
  const person = rng.pick(team);
  const added = create(proc.requirementType, project === 'Smart Operations Platform' ? 'Hotfix: تنبيهات Alerts مكررة بعد إعادة تشغيل الخدمة' : 'Hotfix: رسالة Welcome Email تُرسل مرتين', {
    'System.AssignedTo': assign(person),
    'System.IterationPath': next ? next.path : current.path,
    [proc.estimateField]: 3,
  }, at(addWorkingDays(current.start, -2), 12), lead);
  link(features[0].item, added, at(addWorkingDays(current.start, -2), 12, 30), lead);
  change(added, at(addWorkingDays(current.start, 2), 9, 40), lead, { 'System.IterationPath': current.path });
  const task = create(proc.taskType, 'إصلاح مشكلة الإرسال المكرر وإضافة Unit Tests', { 'System.AssignedTo': assign(person), 'System.IterationPath': current.path, ...hoursFields(6) }, at(addWorkingDays(current.start, 2), 10), person);
  link(added, task, at(addWorkingDays(current.start, 2), 10, 5), person);

  const removed = create(proc.requirementType, project === 'Smart Operations Platform' ? 'تكامل تجريبي مع Chat Bot للتنبيهات' : 'برنامج Loyalty Points التجريبي', {
    'System.AssignedTo': assign(rng.pick(team)),
    'System.IterationPath': current.path,
    [proc.estimateField]: 5,
  }, at(addWorkingDays(current.start, -3), 12), lead);
  link(features[0].item, removed, at(addWorkingDays(current.start, -3), 12, 30), lead);
  change(removed, at(addWorkingDays(current.start, 3), 11, 15), lead, { 'System.IterationPath': next ? next.path : project });
}

/** Blocked by tag, by field and (where the convention names one) by state, plus a stalled item. */
function plantBlockedAndStalled({ rng, proc, project, current, today, stories, lead, create, change, link, assign, teamPeople, stateOf, categoryOf }) {
  const inCurrent = stories.filter((s) => s.sprint === current);
  const canPark = (proc.states[proc.taskType] || []).some((s) => s.name === 'On Hold');
  const since = addWorkingDays(today, -3);
  const openStory = (cat) => inCurrent.find((s) => categoryOf(s.story.fields['System.WorkItemType'], s.story.fields['System.State']) === cat);
  if (proc.blockedField && canPark) {
    // Two tasks parked in "On Hold" three working days ago, so the Blocked view can say how long. One also
    // carries the blocked tag and one the blocked field, so every way of marking blocked appears.
    const waiting = teamPeople(project === 'Customer Experience Portal' ? 'ux' : 'infra').find((p) => p.key !== 'mona') || lead;
    const parent = openStory('InProgress') || openStory('Proposed');
    const park = (title, requested, extra) => {
      // Held up under the story's own owner, so that person's view of the story stays coherent.
      const owner = (parent && parent.owner) || requested;
      const task = create(proc.taskType, title, {
        'System.AssignedTo': assign(owner),
        'System.IterationPath': current.path,
        ...hoursFields(8),
        [proc.blockedField]: 'No',
      }, at(addWorkingDays(since, -1), 10), owner);
      if (parent) link(parent.story, task, at(addWorkingDays(since, -1), 10, 5), owner);
      change(task, at(since, 14, 10), owner, { 'System.State': 'On Hold', ...extra });
    };
    park('Integrate Payment Sandbox بعد وصول الـ Credentials', waiting, { [proc.blockedField]: 'Yes' });
    park('تفعيل Single Sign-On بعد اعتماد Security Review', lead, { 'System.Tags': 'blocked' });
  }
  if (project === 'Smart Operations Platform') {
    const imp = create('Impediment', 'بانتظار موافقة Security Review على بيئة Staging', { 'System.AssignedTo': assign(lead), 'System.IterationPath': current.path }, at(addWorkingDays(since, -1), 11), lead);
    change(imp, at(since, 11, 20), lead, { 'System.State': stateOf('Impediment', 'InProgress') });
  }
  // Stalled: in progress, untouched for over a week of working days.
  const team = teamPeople(project === 'Customer Experience Portal' ? 'apps' : project === 'Smart Operations Platform' ? 'ops' : 'infra');
  const person = team.find((p) => p.key !== 'mona') || lead;
  const quietSince = addWorkingDays(today, -6);
  const stalled = create(proc.taskType, project === 'Smart Operations Platform' ? 'ترحيل Alert Tokens إلى Notification Provider الجديد' : 'إعادة هيكلة Session Storage في Authentication Service', {
    'System.AssignedTo': assign(person),
    'System.IterationPath': current.path,
    ...hoursFields(12),
  }, at(addDays(quietSince, -1), 10), person);
  change(stalled, at(quietSince, 15), person, {
    'System.State': stateOf(proc.taskType, 'InProgress'),
    'Microsoft.VSTS.Scheduling.CompletedWork': 3,
    'Microsoft.VSTS.Scheduling.RemainingWork': 9,
  });
  const parent = openStory('InProgress');
  if (parent) {
    parent.story.relations.push({ rel: 'System.LinkTypes.Hierarchy-Forward', url: `https://dev.azure.com/masar/_apis/wit/workItems/${stalled.id}`, attributes: { name: 'Child' } });
    stalled.relations.push({ rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/masar/_apis/wit/workItems/${parent.story.id}`, attributes: { name: 'Parent' } });
    for (const r of stalled.revisions) r.fields['System.Parent'] = parent.story.id;
    stalled.fields['System.Parent'] = parent.story.id;
  }
}

/**
 * Re-estimates. One story is re-estimated upward mid-sprint; another spans two
 * closed sprints and is re-estimated downward below the share the first
 * sprint already credited, which velocity discloses rather than claws back.
 */
function plantReestimates({ rng, proc, project, sprintsByIndex, current, today, lead, features, create, change, link, work, assign, finishStory, teamPeople }) {
  const est = proc.estimateField;
  const inCurrent = sprintsByIndex[current.index];
  const team = teamPeople(features[0].teamKey);

  const up = create(proc.requirementType, project === 'Smart Operations Platform' ? 'Saved Views للوحة العمليات' : 'صفحة Order Tracking مع تحديث Live للحالة', {
    'System.AssignedTo': assign(lead),
    'System.IterationPath': inCurrent.path,
    [est]: 3,
  }, at(addWorkingDays(inCurrent.start, -2), 13), lead);
  link(features[0].item, up, at(addWorkingDays(inCurrent.start, -2), 13, 10), lead);
  // The story is the lead's; a teammate builds it.
  const upDev = team.find((p) => p.key !== 'mona') || lead;
  const upTask = create(proc.taskType, 'Prototype لمكوّن Live Status', { 'System.AssignedTo': assign(upDev), 'System.IterationPath': inCurrent.path, ...hoursFields(48) }, at(inCurrent.start, 10), upDev);
  link(up, upTask, at(inCurrent.start, 10, 5), upDev);
  work(upTask, workingDaysBetween(inCurrent.start, today), upDev, { chance: 0.6, story: up });
  change(up, at(addWorkingDays(inCurrent.start, 3), 11), lead, { [est]: 8 });
  change(up, at(addWorkingDays(today, -1), 11, 30), lead, {});

  const first = sprintsByIndex[current.index - 2];
  const second = sprintsByIndex[current.index - 1];
  if (!first || !second) return;
  const person = rng.pick(team);
  const down = create(proc.requirementType, project === 'Smart Operations Platform' ? 'إعادة كتابة Onboarding Wizard للمشغلين' : 'استيراد جهات الاتصال (Contacts Import) للعملاء', {
    'System.AssignedTo': assign(person),
    'System.IterationPath': first.path,
    [est]: 8,
  }, at(addWorkingDays(first.start, -2), 10), lead);
  link(features[0].item, down, at(addWorkingDays(first.start, -2), 10, 10), lead);
  const a = create(proc.taskType, 'Parse للملفات المستوردة', { 'System.AssignedTo': assign(person), 'System.IterationPath': first.path, ...hoursFields(8) }, at(first.start, 9), person);
  const b = create(proc.taskType, 'UI لاختيار جهة الاتصال', { 'System.AssignedTo': assign(person), 'System.IterationPath': first.path, ...hoursFields(8) }, at(first.start, 9, 10), person);
  const c = create(proc.taskType, 'معالجة حالات خطأ الاستيراد', { 'System.AssignedTo': assign(person), 'System.IterationPath': first.path, ...hoursFields(8) }, at(first.start, 9, 20), person);
  for (const t of [a, b, c]) link(down, t, at(first.start, 9, 30), person);
  const firstDays = workingDaysBetween(first.start, first.finish);
  work(a, firstDays, person, { finish: true });
  if (down.fields['System.State'] === proc.states[proc.requirementType][0].name) {
    change(down, at(first.start, 11), person, { 'System.State': proc.states[proc.requirementType].find((s) => s.category === 'InProgress').name });
  }
  change(b, at(addWorkingDays(first.finish, -1), 16), person, {
    'System.State': proc.states[proc.taskType].find((s) => s.category === 'InProgress').name,
    'Microsoft.VSTS.Scheduling.CompletedWork': 4,
    'Microsoft.VSTS.Scheduling.RemainingWork': 4,
  });
  change(down, at(second.start, 9), lead, { 'System.IterationPath': second.path });
  change(b, at(second.start, 9, 5), lead, { 'System.IterationPath': second.path });
  change(c, at(second.start, 9, 10), lead, { 'System.IterationPath': second.path });
  change(down, at(addWorkingDays(second.start, 1), 10), lead, { [est]: 3 });
  const secondDays = workingDaysBetween(second.start, second.finish);
  work(b, secondDays.slice(0, 3), person, { finish: true });
  work(c, secondDays.slice(2, 5), person, { finish: true });
  finishStory(down, addWorkingDays(second.finish, -4), person);
}

/** Items the lead used to own and were handed to someone else — for search. */
function plantPastOwnership({ rng, proc, project, sprintsByIndex, current, lead, create, change, work, assign, teamPeople }) {
  const team = teamPeople(project === 'Customer Experience Portal' ? 'apps' : project === 'Smart Operations Platform' ? 'ops' : 'infra').filter((p) => p.key !== 'mona');
  const titles = ['مراجعة Analytics Events الخاصة بـ Onboarding', 'Load Test لـ Registration API', 'مراجعة نصوص Onboarding مع UX Writing'];
  titles.forEach((title, i) => {
    const sprint = sprintsByIndex[Math.max(0, current.index - 1 - i)];
    const heir = team[i % team.length] || lead;
    const t = create(proc.taskType, title, { 'System.AssignedTo': assign(lead), 'System.IterationPath': sprint.path, ...hoursFields(6) }, at(sprint.start, 10), lead);
    change(t, at(addWorkingDays(sprint.start, 2), 11), lead, { 'System.AssignedTo': assign(heir) });
    work(t, workingDaysBetween(addWorkingDays(sprint.start, 3), sprint.finish), heir, { finish: true });
  });
}

/** Work still assigned to one person's retired, pre-migration identity. */
function plantLinkedIdentity({ proc, project, sprintsByIndex, current, today, byKey, create, work }) {
  const liam = byKey.get('mohammed');
  if (!liam || !liam.linked || !liam.projects.includes(project)) return;
  const legacy = { ...liam.linked, descriptor: `aad.${liam.linked.id.replace(/-/g, '')}` };
  const legacyRef = { displayName: legacy.displayName, id: legacy.id, uniqueName: legacy.uniqueName, descriptor: legacy.descriptor, url: '', imageUrl: '' };
  const legacyPerson = { ...legacy };
  [
    ['إيقاف Legacy Endpoints القديمة لخدمة الإشعارات', sprintsByIndex[current.index - 2]],
    ['تسليم مفاتيح Payment Sandbox للفريق الجديد', sprintsByIndex[current.index - 1]],
    ['توثيق Rollback Runbook لخدمة Onboarding', current],
  ].forEach(([title, sprint]) => {
    if (!sprint) return;
    const t = create(proc.taskType, title, { 'System.AssignedTo': legacyRef, 'System.IterationPath': sprint.path, ...hoursFields(6) }, at(sprint.start, 11), legacyPerson);
    const isPast = sprint !== current;
    work(t, workingDaysBetween(sprint.start, isPast ? sprint.finish : today), legacyPerson, { finish: isPast, chance: 0.6 });
  });
}

/** One story cut from scope entirely. */
function plantRemoved({ proc, project, sprintsByIndex, current, lead, features, create, change, link, assign }) {
  const sprint = sprintsByIndex[current.index - 1];
  const s = create(proc.requirementType, project === 'Smart Operations Platform' ? 'إرسال تقارير الأعطال عبر Chat Bot' : 'خيار Dark Theme التجريبي في Customer Portal', {
    'System.AssignedTo': assign(lead),
    'System.IterationPath': sprint.path,
    [proc.estimateField]: 5,
  }, at(addWorkingDays(sprint.start, -2), 10), lead);
  link(features[0].item, s, at(addWorkingDays(sprint.start, -2), 10, 5), lead);
  change(s, at(addWorkingDays(sprint.start, 4), 15), lead, { 'System.State': 'Removed' });
}

/** The custom `Spike` type: one under a story, two on their own. */
function plantSpikes({ rng, proc, sprintsByIndex, current, lead, stories, create, link, work, assign, teamPeople, categoryOf }) {
  const team = teamPeople('infra');
  SPIKE_TITLES.forEach((title, i) => {
    const sprint = i === 0 ? current : sprintsByIndex[current.index - i];
    const person = i === 0 ? lead : rng.pick(team);
    const spike = create(proc.spikeType, title, { 'System.AssignedTo': assign(person), 'System.IterationPath': sprint.path, ...hoursFields(8) }, at(sprint.start, 10), person);
    // Under a story that is still open, or — when every story this sprint is already resolved — under one of those with the spike concluded.
    let concluded = false;
    if (i === 0) {
      const inSprint = stories.filter((s) => s.sprint === current);
      const open = inSprint.find((s) => categoryOf(s.story.fields['System.WorkItemType'], s.story.fields['System.State']) === 'InProgress');
      const closed = inSprint.find((s) => ['Resolved', 'Completed'].includes(categoryOf(s.story.fields['System.WorkItemType'], s.story.fields['System.State'])));
      const parent = open || closed;
      if (parent) link(parent.story, spike, at(sprint.start, 10, 10), lead);
      concluded = !!parent && !open;
    }
    const isPast = sprint !== current;
    work(spike, workingDaysBetween(sprint.start, isPast ? sprint.finish : addWorkingDays(sprint.start, 4)), person, { finish: isPast || concluded, chance: 0.6 });
  });
}

/**
 * An active story shows, on each person's page, the progress of the tasks that person holds. So that no
 * page shows an active story at 0% or 100%, the open story's tasks are held by one person: its owner
 * when the owner still has open work, else whoever has the most. Idle (stalled) and parked tasks stay put.
 */
function reconcileActiveStories({ items, proc, people, today, categoryOf, change, assign }) {
  const byUnique = new Map(people.map((p) => [p.uniqueName.toLowerCase(), p]));
  const num = (i, f) => Number(i.fields[f]) || 0;
  const assignedU = (i) => (i.fields['System.AssignedTo'] ? String(i.fields['System.AssignedTo'].uniqueName).toLowerCase() : null);
  const kidsOf = new Map();
  for (const i of items) {
    const parent = i.fields['System.Parent'];
    if (parent) kidsOf.set(parent, [...(kidsOf.get(parent) || []), i]);
  }
  const staleBefore = addWorkingDays(today, -3).getTime();
  for (const s of items) {
    const type = s.fields['System.WorkItemType'];
    if (type !== proc.requirementType || categoryOf(type, s.fields['System.State']) !== 'InProgress') continue;
    const kids = (kidsOf.get(s.id) || []).filter((k) => k.fields['Microsoft.VSTS.Scheduling.OriginalEstimate'] !== undefined && categoryOf(k.fields['System.WorkItemType'], k.fields['System.State']) !== 'Removed');
    const open = kids.filter((k) => num(k, 'Microsoft.VSTS.Scheduling.RemainingWork') > 0);
    if (open.length === 0) continue;
    const ownerU = assignedU(s);
    let anchorU = ownerU;
    if (!open.some((k) => assignedU(k) === ownerU)) {
      const left = new Map();
      for (const k of open) left.set(assignedU(k), (left.get(assignedU(k)) || 0) + num(k, 'Microsoft.VSTS.Scheduling.RemainingWork'));
      anchorU = [...left.entries()].sort((a, b) => b[1] - a[1])[0][0];
    }
    const anchor = byUnique.get(anchorU);
    if (!anchor) continue;
    const when = () => at(today, 8, 10 + (s.id % 40));
    for (const k of kids) {
      if (assignedU(k) === anchorU || k.fields['System.State'] === 'On Hold') continue;
      const idle = categoryOf(k.fields['System.WorkItemType'], k.fields['System.State']) === 'InProgress' && Date.parse(k.fields['System.ChangedDate']) < staleBefore;
      if (idle) continue;
      change(k, when(), anchor, { 'System.AssignedTo': assign(anchor) });
    }
    if (ownerU !== anchorU) change(s, when(), anchor, { 'System.AssignedTo': assign(anchor) });
  }
}

/** Open stories in the current sprint get touched in the last few days (a comment, a field edit — each
 * is a revision), so only the item planted as stalled looks idle. */
function plantRecentActivity({ rng, current, today, stories, categoryOf, change }) {
  for (const s of stories.filter((x) => x.sprint === current)) {
    const type = s.story.fields['System.WorkItemType'];
    if (categoryOf(type, s.story.fields['System.State']) !== 'InProgress') continue;
    change(s.story, at(addWorkingDays(today, -rng.int(0, 2)), rng.int(9, 15), rng.int(0, 59)), s.owner, {});
  }
}

// Hours per working day each person logs on the current sprint, at least; anyone below it gets a task of
// their own. A few are deliberately low (a project manager, a developer split across projects).
const ROSTER_RATES = { abdullah: 3, aya: 5, khaled: 5.5, noura: 3.5, sara: 6, mohammed: 6, yasmine: 5.5, ahmed: 5.5, fatima: 5.5, mostafa: 6, ahmedq: 5.5, omar: 5, abdulrahman: 5.5, mahmoud: 5.5, nada: 3 };
const ROSTER_TITLES = {
  abdullah: 'متابعة Release Planning مع قادة الفرق',
  aya: 'تجهيز Sprint Review وتحديث Product Backlog',
  noura: 'مراجعة Integration Tests مع فريق Customer Portal',
  nada: 'تحديث Runbooks وتوثيق Deployment Process',
};

/** Everyone on the project's roster logs something in the current sprint. */
function plantRosterHours({ proc, project, people, current, today, items, create, work, assign }) {
  const end = today > current.finish ? current.finish : today;
  const days = workingDaysBetween(current.start, end);
  if (days.length === 0) return;
  const logged = loggedHours(items, current.start, end);
  for (const p of people.filter((x) => x.projects.includes(project) && x.key !== 'mona')) {
    // Outside their own project, a person only spends a couple of hours a day here.
    const rate = p.projects[0] === project ? ROSTER_RATES[p.key] || 4 : 2;
    const floor = rate * days.length;
    const have = logged.get(p.uniqueName.toLowerCase()) || 0;
    if (have >= floor - 1) continue;
    const need = Math.ceil((floor - have) / 0.5) * 0.5;
    // Several tasks of a believable size rather than one enormous one.
    const count = Math.ceil(need / 18);
    const share = need / count;
    const titles = [ROSTER_TITLES[p.key] || (p.role === 'lead' ? 'متابعة Technical Debt مع الفريق' : 'مراجعة Code Review وتحسين Test Coverage'), 'تحسين Error Handling وإضافة Logging', 'تحديث Documentation وتجهيز Release Notes'];
    for (let n = 0; n < count; n += 1) {
      const task = create(proc.taskType, titles[n % titles.length], { 'System.AssignedTo': assign(p), 'System.IterationPath': current.path, ...hoursFields(Math.ceil(share * 1.4)) }, at(current.start, 9, 40 + n), p);
      work(task, days, p, { chance: 1, daily: share / days.length });
    }
  }
}

module.exports = { buildWorkItems };
