const { renderOrgMarkdown } = require('../../org');

/**
 * The org chart (and blocked convention) each project's wiki holds on its
 * "Dashboard Roles" page, in exactly the format server/orgStore.js reads and
 * writes. Enterprise Cloud Platform has no wiki at all, which the app handles by
 * design — so it is left out here.
 */
function orgChart(allPeople, teams, projectName) {
  // Each project's chart holds only the people who work in that project.
  const people = allPeople.filter((p) => p.projects.includes(projectName));
  const memberId = (key, suffix = '') => `m-${key}${suffix}`;
  const teamId = (key) => `t-${key}`;
  const managers = { apps: 'mona', ux: 'khaled', ops: 'noura', infra: 'mahmoud' };

  const members = [];
  const head = people.find((p) => p.key === 'abdullah');
  members.push({ id: memberId('abdullah'), email: head.uniqueName, displayName: head.displayName, role: 'lead', teamId: null, parentId: null });
  const present = new Set(people.map((p) => p.key));
  const chartTeams = [];
  for (const [teamKey, managerKey] of Object.entries(managers)) {
    if (!present.has(managerKey)) continue;
    const m = people.find((p) => p.key === managerKey);
    members.push({ id: memberId(managerKey), email: m.uniqueName, displayName: m.displayName, role: 'lead', teamId: null, parentId: memberId('abdullah') });
    const teamPeople = people.filter((x) => x.teamKey === teamKey && x.key !== managerKey);
    // A team joins the chart only when someone besides its manager works in this project.
    if (teamPeople.length > 0) chartTeams.push(teamKey);
    for (const p of teamPeople) {
      let parentId = memberId(managerKey);
      // Two apps-team developers report to the principal rather than the lead.
      if (p.role === 'developer' && teamKey === 'apps' && ['yasmine', 'ahmed'].includes(p.key)) parentId = present.has('sara') ? memberId('sara') : parentId;
      members.push({ id: memberId(p.key), email: p.uniqueName, displayName: p.displayName, role: p.role, teamId: teamId(teamKey), parentId });
    }
  }

  return {
    version: 1,
    teams: teams.filter((t) => chartTeams.includes(t.key)).map((t) => ({ id: teamId(t.key), name: t.name, managerMemberId: memberId(managers[t.key]) })),
    members,
  };
}

const CONVENTIONS = {
  agile: {
    version: 1,
    byType: {
      Task: { states: ['On Hold'], tags: ['blocked'], field: 'Microsoft.VSTS.CMMI.Blocked', fieldBlockedValue: 'Yes' },
      'User Story': { states: [], tags: ['blocked'] },
      Bug: { states: [], tags: ['blocked'] },
    },
  },
  scrum: {
    version: 1,
    byType: {
      Impediment: { states: ['Open'], tags: [] },
      'Product Backlog Item': { states: [], tags: ['blocked'] },
      Task: { states: [], tags: ['blocked'] },
    },
  },
};

function buildWikis({ projects, people, teams, rolesWikiPage = '/Dashboard Roles' }) {
  const wikis = {};
  for (const project of projects) {
    if (project.name === 'Enterprise Cloud Platform') continue;
    const chart = orgChart(people, teams, project.name);
    const store = { ...chart, blockedConvention: CONVENTIONS[project.process.key] || null };
    wikis[project.name] = {
      id: project.wikiId,
      name: `${project.name}.wiki`,
      pages: { [rolesWikiPage]: { content: renderOrgMarkdown(store), eTag: '"1"' } },
    };
  }
  return wikis;
}

module.exports = { buildWikis, orgChart };
