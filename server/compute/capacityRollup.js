/**
 * US3: turns raw ADO capacity records + logged hours into per-person
 * utilisation (FR-020 through FR-026a). Pure — no ADO/cache access; the
 * caller (server/scrum.js) gathers `capacityRecords` from
 * server/ado/capacity.js and `loggedHoursByPerson` from the revision index.
 * See data-model.md §5.
 */

const { UTILISATION_OVER, UTILISATION_UNDER } = require('../scrumConstants');

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function isWorkingDay(dateStr, workingDays) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return workingDays.has(WEEKDAY_NAMES[day]);
}

function isWithinAnyRange(dateStr, ranges) {
  return ranges.some((r) => r && r.start && r.end && dateStr >= String(r.start).slice(0, 10) && dateStr <= String(r.end).slice(0, 10));
}

/**
 * Counts the working days in `[startDate, finishDate]` (inclusive, both ISO
 * date/datetime strings) that match `workingDays` (a lowercase weekday-name
 * Set) and are not covered by any `{start, end}` range in `offRanges` — team
 * days off and a person's own days off, pre-merged by the caller. Pure
 * arithmetic over recorded values (server/ado/capacity.js A1): FR-021a-ii
 * forbids ASSUMING a working-day pattern, not counting a real one against a
 * real date range.
 * @returns {number|null} null when `workingDays` is absent/empty — the
 *   caller's signal to treat the whole allocation as not-recorded rather
 *   than dividing by zero or guessing a pattern.
 */
function sprintWorkingDayCount(startDate, finishDate, workingDays, offRanges = []) {
  if (!workingDays || workingDays.size === 0) return null;
  if (!startDate || !finishDate) return null;
  let count = 0;
  const start = new Date(`${String(startDate).slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${String(finishDate).slice(0, 10)}T00:00:00Z`);
  for (let d = start; d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    const iso = d.toISOString().slice(0, 10);
    if (isWorkingDay(iso, workingDays) && !isWithinAnyRange(iso, offRanges)) count += 1;
  }
  return count;
}

function bandOf(utilisation) {
  if (utilisation == null) return null;
  if (utilisation >= UTILISATION_OVER) return 'over';
  if (utilisation <= UTILISATION_UNDER) return 'under';
  return 'normal';
}

/** Groups one person's capacity records into an AvailableTime. FR-021a-iii:
 * distinct-team records are summed. FR-021a-iv: two records naming the SAME
 * team (which the ADO schema should never produce, but a hand-edited or
 * anomalous response could) are non-additive — no total is invented, and
 * both are named as conflicts. */
function availableTimeFor(records) {
  if (!records || records.length === 0) {
    return { status: 'not-recorded', hours: null, allocations: [], conflicts: [] };
  }
  const byTeam = new Map();
  const conflicts = [];
  for (const r of records) {
    if (byTeam.has(r.teamId)) {
      conflicts.push(byTeam.get(r.teamId), r);
    } else {
      byTeam.set(r.teamId, r);
    }
  }
  if (conflicts.length > 0) {
    return { status: 'not-additive', hours: null, allocations: records, conflicts: [...new Set(conflicts)] };
  }
  const hours = records.reduce((sum, r) => sum + r.hours, 0);
  return { status: 'known', hours, allocations: records, conflicts: [] };
}

/**
 * @param {Array<{personKey, email, displayName}>} roster the app's own org
 *   chart roster for this project — the single definition of "the team"
 *   (FR-026), never the ADO team.
 * @param {Array<{teamId, teamName, personKey, displayName, hours}>} capacityRecords
 * @param {Map<string, number>} loggedHoursByPerson personKey -> hours logged
 *   this sprint, project-wide (SyncEngine.getLoggedHoursInRange).
 * @returns {{members: Array, summary: object, allUnknown: boolean, offRoster: Array}}
 */
function rollupUtilisation(roster, capacityRecords, loggedHoursByPerson) {
  const capacityByPerson = new Map();
  for (const r of capacityRecords) {
    if (!capacityByPerson.has(r.personKey)) capacityByPerson.set(r.personKey, []);
    capacityByPerson.get(r.personKey).push(r);
  }

  const rosterKeys = new Set(roster.map((m) => m.personKey));
  const members = roster.map((m) => {
    const loggedHours = loggedHoursByPerson.get(m.personKey) || 0; // FR-022: no logged time -> zero, never omitted
    const available = availableTimeFor(capacityByPerson.get(m.personKey));
    // Utilisation requires KNOWN availability, and a known-but-zero total is
    // not meaningfully divisible — treated the same as unknown (null), never
    // as an inflated or infinite figure.
    const utilisation = available.status === 'known' && available.hours > 0 ? loggedHours / available.hours : null;
    return {
      personKey: m.personKey,
      displayName: m.displayName,
      loggedHours, // FR-023: always populated, even when availability is unknown
      available,
      utilisation,
      band: bandOf(utilisation),
    };
  });

  const membersWithKnownAvailability = members.filter((m) => m.available.status === 'known').length;
  const membersExcluded = members.length - membersWithKnownAvailability;

  // FR-026a/FR-026b: people who logged time this sprint but are absent from
  // the roster — named here so they can be fixed, never folded into members,
  // summary, or any team total (FR-026).
  const offRoster = [];
  for (const [personKey, hours] of loggedHoursByPerson) {
    if (!rosterKeys.has(personKey) && hours > 0) {
      const fromCapacity = capacityRecords.find((r) => r.personKey === personKey);
      offRoster.push({ personKey, displayName: (fromCapacity && fromCapacity.displayName) || personKey, loggedHours: hours });
    }
  }

  return {
    members,
    summary: { membersWithKnownAvailability, membersExcluded },
    allUnknown: members.length > 0 && membersWithKnownAvailability === 0,
    offRoster,
  };
}

module.exports = { rollupUtilisation, availableTimeFor, bandOf, sprintWorkingDayCount };
