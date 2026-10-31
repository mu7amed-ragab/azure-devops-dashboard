/**
 * US3: reads each of the project's ADO teams' recorded capacity for one
 * sprint (FR-020 through FR-026). Capacity in Azure DevOps is recorded per
 * TEAM per ITERATION, keyed by team member identity — there is no per-person,
 * project-wide notion of it, and no formula stands in when it is absent
 * (FR-021a-ii; SC-006a). ADO teams are used here only as containers to
 * search, never as an identity source — the org chart roster is what decides
 * who is "on the team" (FR-021a, FR-026, research R4).
 *
 * A1 (2026-08-14 review): `capacityPerDay` is a RATE, not a sprint total —
 * ADO's own Capacity page multiplies it by the team's configured working
 * days, minus team- and person-level days off, to get the number a person
 * can actually work with. This module now does the same multiplication,
 * using only values ADO itself records for this team and this iteration
 * (`work/teamsettings`'s `workingDays`, `.../teamdaysoff`, and each row's own
 * `daysOff` already present in the capacities response) — arithmetic over
 * recorded values, not the working-days FALLBACK revision 3 killed (FR-021a-
 * ii still forbids ASSUMING a pattern; it says nothing against multiplying a
 * real one). Where the team has no configured working-day pattern, that
 * team's allocation is silently absent (the same treatment a 404/400 on
 * `/capacities` already gets) rather than guessed — FR-023's "no fallback"
 * rule extends to this new denominator exactly as it did to the old one.
 */

const { sprintWorkingDayCount } = require('../compute/capacityRollup');

function teamScopedUrl(client, teamName, apiPath, query = {}) {
  const url = new URL(`https://dev.azure.com/${client.org}/${encodeURIComponent(client.project)}/${encodeURIComponent(teamName)}/_apis${apiPath}`);
  url.searchParams.set('api-version', client.apiVersion);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** @returns {Promise<Array<{id, name}>>} every ADO team in this project. */
async function fetchProjectTeams(client, projectId) {
  if (!projectId) return [];
  const result = await client.get(`/projects/${projectId}/teams`, { org: true, query: { $top: 200 } });
  return (result.value || []).map((t) => ({ id: t.id, name: t.name }));
}

/** Lowercased email, matching the convention every other identity comparison
 * in this app uses (server/ado/revisionIndex.js `changedByKey`). ADO's
 * capacities response gives `teamMember.uniqueName`. */
function personKeyOf(teamMember) {
  const raw = teamMember && (teamMember.uniqueName || teamMember.id);
  return raw ? String(raw).trim().toLowerCase() : null;
}

/** This ADO team's configured working days (e.g. Mon–Fri), as a lowercase
 * Set of weekday names — `GET .../_apis/work/teamsettings`. Returns null
 * when the team has none configured (an empty `workingDays` array is a real,
 * observed shape) — null means unknown, never assumed as Mon–Fri. */
async function fetchTeamWorkingDays(client, teamName) {
  const url = teamScopedUrl(client, teamName, '/work/teamsettings');
  let result;
  try {
    result = await client.request(url, { method: 'GET' });
  } catch (err) {
    if (err.status === 404 || err.status === 400) return null;
    throw err;
  }
  const days = (result && result.workingDays) || [];
  if (days.length === 0) return null;
  return new Set(days.map((d) => String(d).toLowerCase()));
}

/** This team's recorded whole-team closures within one iteration (e.g. a
 * public holiday) — `GET .../_apis/work/teamsettings/iterations/{id}/teamdaysoff`.
 * `[]` for a team that never configured any, same treatment as "no capacity
 * recorded" elsewhere in this module. */
async function fetchTeamDaysOff(client, teamName, iterationId) {
  const url = teamScopedUrl(client, teamName, `/work/teamsettings/iterations/${encodeURIComponent(iterationId)}/teamdaysoff`);
  try {
    const result = await client.request(url, { method: 'GET' });
    return (result && result.daysOff) || [];
  } catch (err) {
    if (err.status === 404 || err.status === 400) return [];
    throw err;
  }
}

/**
 * One team's capacity records for one iteration. `hours` is each member's
 * per-day rate (summed across activities) multiplied by the number of the
 * SPRINT'S OWN working days as ADO records them for this team — its
 * `workingDays` pattern, minus the team's `teamdaysoff` and that member's own
 * `daysOff` (already present per-row in the `/capacities` response). `hours`
 * is `null` — the same "not recorded" treatment as a 404 — whenever the
 * team's working-day pattern is unknown, since multiplying a real rate by an
 * assumed day count is exactly the fallback FR-021a-ii forbids.
 * @returns {Promise<Array<{teamId, teamName, personKey, displayName, hours}>>}
 */
async function fetchTeamCapacities(client, team, iterationId, sprint) {
  if (!iterationId) return [];
  const url = teamScopedUrl(client, team.name, `/work/teamsettings/iterations/${encodeURIComponent(iterationId)}/capacities`);
  let result;
  try {
    result = await client.request(url, { method: 'GET' });
  } catch (err) {
    // A team that never configured this iteration in its own team schedule
    // is a normal, common shape (not every ADO team backs every sprint) —
    // observed live as BOTH a 404 and a 400 "The request is invalid" from
    // this endpoint, so both are read as "no capacity recorded here" rather
    // than failing the whole utilisation view for every OTHER team's data.
    if (err.status === 404 || err.status === 400) return [];
    throw err;
  }
  const rows = (result && result.value) || [];
  if (rows.length === 0) return [];

  const [workingDays, teamDaysOff] = await Promise.all([
    fetchTeamWorkingDays(client, team.name),
    fetchTeamDaysOff(client, team.name, iterationId),
  ]);
  const workingDayCount =
    workingDays && sprint && sprint.startDate && sprint.finishDate
      ? sprintWorkingDayCount(sprint.startDate, sprint.finishDate, workingDays, teamDaysOff)
      : null;

  return rows
    .map((r) => {
      const personKey = personKeyOf(r.teamMember);
      if (!personKey) return null;
      const capacityPerDay = (r.activities || []).reduce((sum, a) => sum + (Number(a.capacityPerDay) || 0), 0);
      let hours = null;
      if (workingDayCount != null) {
        const memberDaysOff = r.daysOff || [];
        const effectiveDays = sprintWorkingDayCount(sprint.startDate, sprint.finishDate, workingDays, [...teamDaysOff, ...memberDaysOff]);
        hours = capacityPerDay * effectiveDays;
      }
      if (hours == null) return null; // unknown working-day basis — absent, not guessed (FR-021a-ii)
      return { teamId: team.id, teamName: team.name, personKey, displayName: (r.teamMember && r.teamMember.displayName) || personKey, hours };
    })
    .filter(Boolean);
}

/**
 * Every team's capacity for one sprint, across every ADO team in the
 * project.
 * @param {{startDate:string, finishDate:string}} sprint the selected sprint's
 *   own dates — the only two values this module's working-day arithmetic
 *   reads outside what ADO returns for the team/iteration itself.
 * @returns {Promise<Array<{teamId, teamName, personKey, displayName, hours}>>}
 */
async function fetchAllCapacities(client, projectId, iterationId, sprint) {
  const teams = await fetchProjectTeams(client, projectId);
  const perTeam = await Promise.all(teams.map((t) => fetchTeamCapacities(client, t, iterationId, sprint)));
  return perTeam.flat();
}

module.exports = {
  fetchProjectTeams,
  fetchTeamCapacities,
  fetchAllCapacities,
  fetchTeamWorkingDays,
  fetchTeamDaysOff,
  personKeyOf,
  teamScopedUrl,
};
