const { mulberry32 } = require('./seed/rng');
const calendar = require('./seed/calendar');
const { AGILE, SCRUM, CUSTOM } = require('./seed/processes');
const { buildPeople, identityRef } = require('./seed/people');
const { buildIterations } = require('./seed/iterations');
const { buildWorkItems } = require('./seed/workItems');
const { buildPullRequests } = require('./seed/pullRequests');
const { buildCapacity } = require('./seed/capacity');
const { buildWikis } = require('./seed/wiki');
const { validate } = require('./seed/validate');
const { DEMO_ORG, DEMO_DEFAULT_PROJECT, DEMO_DEFAULT_SEED } = require('./constants');

const PROJECTS = [
  { name: 'Customer Experience Portal', process: AGILE, description: 'Customer portal, onboarding and billing' },
  { name: 'Smart Operations Platform', process: SCRUM, description: 'Operations monitoring, alerting and workflow automation' },
  { name: 'Enterprise Cloud Platform', process: CUSTOM, description: 'Shared cloud services, pipelines and identity' },
];

/**
 * Builds the whole fictional organization from a seed: projects with their
 * own process templates, people, sprints, work item histories, pull
 * requests, capacity and wiki pages. Every date is relative to `now`.
 */
function createDemoOrg({ seed = DEMO_DEFAULT_SEED, now = new Date() } = {}) {
  const rng = mulberry32(seed);
  const today = calendar.today(now);
  const { people, teams } = buildPeople(rng);
  const sprintDates = calendar.sprints(today);

  const projects = PROJECTS.map((def) => {
    const project = {
      id: rng.guid(),
      name: def.name,
      description: def.description,
      process: def.process,
      wikiId: rng.guid(),
    };
    project.iterations = buildIterations(def.name, sprintDates, rng);
    const members = people.filter((p) => p.projects.includes(def.name));
    project.teams = [{ id: rng.guid(), name: `${def.name} Team`, members }];
    for (const team of teams) {
      const teamMembers = members.filter((p) => p.teamKey === team.key);
      if (teamMembers.length > 0) project.teams.push({ id: rng.guid(), name: team.name, members: teamMembers });
    }
    return project;
  });

  let lastId = 401200;
  const nextId = () => {
    lastId += rng.int(1, 7);
    return lastId;
  };
  const workItems = new Map();
  // Hours already logged per person per day, shared so nobody over-logs across projects.
  const hoursLoad = new Map();
  for (const project of projects) {
    const items = buildWorkItems({ rng, project: project.name, proc: project.process, people, iterations: project.iterations, now, nextId, load: hoursLoad });
    for (const item of items) workItems.set(item.id, item);
  }

  const all = [...workItems.values()];
  const { repos, prs } = buildPullRequests({ rng, projects, people, items: all, now });
  const capacity = buildCapacity({ rng, projects, people, items: all, today });
  const wikis = buildWikis({ projects, people, teams });

  const state = {
    org: DEMO_ORG,
    defaultProject: DEMO_DEFAULT_PROJECT,
    now,
    today,
    seed,
    people,
    teams,
    projects,
    workItems,
    repos,
    pullRequests: prs,
    capacity,
    wikis,
    unhandled: new Set(),
    handlerErrors: [],
    nextId,
    findProject(nameOrId) {
      const key = String(nameOrId || '').toLowerCase();
      return projects.find((p) => p.id.toLowerCase() === key || p.name.toLowerCase() === key) || null;
    },
    personByToken: null,
    identityRef,
  };
  validate(state);
  return state;
}

let current = null;
let currentSeed = DEMO_DEFAULT_SEED;
let seededAt = null;

function reseed({ seed = currentSeed, now = new Date() } = {}) {
  currentSeed = seed;
  current = createDemoOrg({ seed, now });
  seededAt = new Date().toISOString();
  return current;
}

function getState() {
  if (!current) reseed();
  return current;
}

module.exports = {
  createDemoOrg,
  reseed,
  getState,
  get seededAt() {
    return seededAt;
  },
};
