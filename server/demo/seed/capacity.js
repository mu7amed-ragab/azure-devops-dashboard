const { workingDaysBetween, isoDate, addDays } = require('./calendar');
const { identityRef } = require('./people');

/** Hours each person logged inside a date range, from the items' revisions. */
function loggedHours(items, from, to) {
  const fromMs = from.getTime();
  const toMs = addDays(to, 1).getTime();
  const out = new Map();
  for (const item of items) {
    let prev = 0;
    for (const rev of item.revisions) {
      const completed = Number(rev.fields['Microsoft.VSTS.Scheduling.CompletedWork']) || 0;
      const delta = completed - prev;
      prev = completed;
      if (delta <= 0) continue;
      const ms = Date.parse(rev.fields['System.ChangedDate']);
      if (ms < fromMs || ms >= toMs) continue;
      const by = rev.fields['System.ChangedBy'];
      const key = String(by.uniqueName).toLowerCase();
      out.set(key, (out.get(key) || 0) + delta);
    }
  }
  return out;
}

/**
 * Per project team and sprint, the capacity rows the team-scoped capacities
 * endpoint returns. Capacity is set from what each person actually logged so
 * the utilisation view shows a spread: one person clearly over-allocated, one
 * clearly under, everyone else near full.
 */
function buildCapacity({ rng, projects, people, items, today }) {
  const out = {};
  for (const project of projects) {
    const team = project.teams[0];
    const members = people.filter((p) => p.projects.includes(project.name));
    const projectItems = items.filter((i) => i.fields['System.TeamProject'] === project.name);
    const holiday = project.iterations.flat[1];
    const teamDaysOff = holiday ? [{ start: isoDate(addDays(holiday.start, 3)), end: isoDate(addDays(holiday.start, 3)) }] : [];

    for (const sprint of project.iterations.flat) {
      const elapsedEnd = sprint.finish < today ? sprint.finish : today;
      const totalDays = workingDaysBetween(sprint.start, sprint.finish).length - (sprint === holiday ? 1 : 0);
      const elapsedDays = sprint.start > today ? 0 : workingDaysBetween(sprint.start, elapsedEnd).length;
      const logged = sprint.start > today ? new Map() : loggedHours(projectItems, sprint.start, elapsedEnd);
      const isCurrent = sprint.start <= today && today <= sprint.finish;

      const rows = members.map((p) => {
        // Hours under a retired identity count for the same person, as the app merges them.
        const hours = (logged.get(p.uniqueName.toLowerCase()) || 0) + (p.linked ? logged.get(p.linked.uniqueName.toLowerCase()) || 0 : 0);
        // A normal day is six hours; anyone logging more than that gets the capacity to match, never less than they logged.
        const daysOff = isCurrent && p.key === 'yasmine' ? [{ start: isoDate(addDays(sprint.start, 8)), end: isoDate(addDays(sprint.start, 9)) }] : [];
        const available = Math.max(totalDays - (daysOff.length ? 2 : 0), 1);
        const perDay = Math.min(8, Math.max(6, Math.ceil((hours / (0.95 * available)) * 2) / 2));
        return {
          teamMember: identityRef(p),
          activities: [{ name: 'Development', capacityPerDay: perDay }],
          daysOff,
        };
      });
      out[`${project.name}::${team.name}::${sprint.identifier}`] = { value: rows, teamDaysOff };
    }
  }
  return out;
}

module.exports = { buildCapacity, loggedHours };
