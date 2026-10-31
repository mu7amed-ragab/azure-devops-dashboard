const { isoDate } = require('./calendar');

// Each project numbers its sprints differently, as real projects would.
const SPRINT_OFFSET = { 'Customer Experience Portal': 21, 'Smart Operations Platform': 8, 'Enterprise Cloud Platform': 34 };
const SPRINTS_PER_RELEASE = 4;

/**
 * The project's iteration tree in the classification-node shape
 * `GET /wit/classificationnodes/Iterations` returns, plus a flat list. Paths
 * are `<Project>\Release N\Sprint K`, matching what System.IterationPath holds.
 */
function buildIterations(projectName, sprints, rng) {
  const base = SPRINT_OFFSET[projectName] || 1;
  const flat = sprints.map((s) => {
    const number = base + s.index;
    const release = Math.floor((number - 1) / SPRINTS_PER_RELEASE) + 1;
    return {
      id: rng.int(10000, 99999),
      identifier: rng.guid(),
      name: `Sprint ${number}`,
      release: `Release ${release}`,
      path: `${projectName}\\Release ${release}\\Sprint ${number}`,
      startDate: isoDate(s.start),
      finishDate: isoDate(s.finish),
      start: s.start,
      finish: s.finish,
      index: s.index,
    };
  });

  const releases = new Map();
  for (const it of flat) {
    if (!releases.has(it.release)) {
      releases.set(it.release, { id: rng.int(10000, 99999), identifier: rng.guid(), name: it.release, structureType: 'iteration', hasChildren: true, children: [] });
    }
    releases.get(it.release).children.push({
      id: it.id,
      identifier: it.identifier,
      name: it.name,
      structureType: 'iteration',
      hasChildren: false,
      attributes: { startDate: it.startDate, finishDate: it.finishDate },
    });
  }

  const tree = {
    id: rng.int(10000, 99999),
    identifier: rng.guid(),
    name: projectName,
    structureType: 'iteration',
    hasChildren: true,
    children: [...releases.values()],
  };
  return { tree, flat };
}

module.exports = { buildIterations };
