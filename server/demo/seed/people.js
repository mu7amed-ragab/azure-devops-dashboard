const { PEOPLE, TEAMS } = require('./vocabulary');

const DOMAIN = 'masar.dev';
const LEGACY_DOMAIN = 'masar-legacy.dev';

// Which fictional projects each team works in. The lead (Mona) and the head of
// engineering work across all three, so the cross-project views have content.
const TEAM_PROJECTS = {
  apps: ['Customer Experience Portal'],
  ux: ['Customer Experience Portal'],
  ops: ['Smart Operations Platform'],
  infra: ['Enterprise Cloud Platform'],
};
const EXTRA_PROJECTS = {
  abdullah: ['Customer Experience Portal', 'Smart Operations Platform', 'Enterprise Cloud Platform'],
  mona: ['Customer Experience Portal', 'Smart Operations Platform', 'Enterprise Cloud Platform'],
  sara: ['Customer Experience Portal', 'Smart Operations Platform'],
  ahmed: ['Enterprise Cloud Platform'],
  noura: ['Customer Experience Portal'],
};

const PERSON_KEYS = { lead: 'mona', member: 'mohammed', principal: 'sara' };

function buildPeople(rng) {
  const people = PEOPLE.map(([key, name, handle, teamKey, role, jobTitle]) => {
    const projects = new Set([...(teamKey ? TEAM_PROJECTS[teamKey] : []), ...(EXTRA_PROJECTS[key] || [])]);
    return {
      key,
      id: rng.guid(),
      displayName: name,
      uniqueName: `${handle}@${DOMAIN}`,
      role,
      jobTitle,
      teamKey,
      projects: [...projects],
      descriptor: `aad.${rng.hex(32)}`,
    };
  });
  // One person still carries an identity from before the company's domain
  // move — the app links the two by matching the part before the @.
  const member = people.find((p) => p.key === 'mohammed');
  member.linked = { id: rng.guid(), displayName: member.displayName, uniqueName: `${member.uniqueName.split('@')[0]}@${LEGACY_DOMAIN}` };
  return { people, teams: TEAMS.map((t) => ({ ...t })) };
}

function identityRef(person) {
  return {
    displayName: person.displayName,
    url: `https://vssps.dev.azure.com/masar/_apis/Identities/${person.id}`,
    id: person.id,
    uniqueName: person.uniqueName,
    imageUrl: '',
    descriptor: person.descriptor || `aad.${person.id.replace(/-/g, '')}`,
  };
}

/** `"Display Name <email>"` — how revisions report System.ChangedBy. */
function changedByString(person) {
  return `${person.displayName} <${person.uniqueName}>`;
}

function peopleInProject(people, projectName) {
  return people.filter((p) => p.projects.includes(projectName));
}

module.exports = { buildPeople, identityRef, changedByString, peopleInProject, PERSON_KEYS, DOMAIN, LEGACY_DOMAIN };
