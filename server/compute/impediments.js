/**
 * US5: blocked and stalled items for the selected sprint (FR-035 through
 * FR-040). Pure over a sprint's SprintItem list (server/ado/sprintItems.js),
 * the project's configured BlockedConvention (server/blockedConvention.js),
 * and — for a state-matched item's duration — its `state` revision history.
 * See data-model.md §7.
 */

const { matchBlocked } = require('../blockedConvention');
const { STALENESS_WORKING_DAYS } = require('../scrumConstants');

/** Weekday count strictly between `fromDate` and `toDate` (both ISO dates or
 * timestamps) — staleness/duration counted in WORKING days, so a normal
 * weekend never trips the threshold (FR-038). */
function workingDaysBetween(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const from = new Date(String(fromDate).slice(0, 10) + 'T00:00:00Z');
  const to = new Date(String(toDate).slice(0, 10) + 'T00:00:00Z');
  let days = 0;
  for (let d = new Date(from.getTime() + 86400000); d.getTime() <= to.getTime(); d = new Date(d.getTime() + 86400000)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

/** The start of the item's CURRENT spell in a blocked state (FR-035-i) — the
 * most recent revision whose `state` entered one of `states` from something
 * else, walking the history from the end. Not the first-ever entry — a
 * story that was blocked, unblocked, and blocked again measures from the
 * second entry. Returns null if history never shows the transition (the
 * index starts after it happened, or the field was never recorded). */
function currentSpellStart(revisions, states) {
  let start = null;
  let prevInState = false;
  for (const rev of revisions) {
    const inState = rev.state != null && states.includes(rev.state);
    if (inState && !prevInState) start = rev.changedDate;
    prevInState = inState;
  }
  return prevInState ? start : null;
}

/**
 * @param {Array} sprintItems SprintItem records for every item currently in
 *   the sprint, any type (data-model.md §2a).
 * @param {object} convention BlockedConvention (server/blockedConvention.js).
 * @param {(id:number) => Array} getRevisionsFor SyncEngine.getRevisionsFor,
 *   used only for a state-matched item's duration.
 * @param {string} today ISO date/timestamp.
 * @returns {{items: Array}}
 */
function computeImpediments(sprintItems, convention, getRevisionsFor, today) {
  const items = [];
  for (const item of sprintItems) {
    // Completed and removed items are exempt from both conditions.
    if (item.stateCategory === 'Completed' || item.stateCategory === 'Removed') continue;

    // BLOCKED IGNORES WORKFLOW CATEGORY — a blocked state is commonly
    // categorised Proposed in this org (this org's Task workflow puts
    // OnHold in Proposed). STALLED REQUIRES In Progress. This asymmetry is
    // deliberate, not an oversight: "blocked" is a state someone
    // deliberately parked the item in regardless of where that state sits
    // in the workflow, while "stalled" means work that should be moving but
    // has gone quiet — which only means something once work has actually
    // started. Conflating the two would either miss OnHold entirely (if
    // blocked required InProgress) or flag every untouched backlog item (if
    // stalled ignored category).
    const match = matchBlocked(item, convention);
    if (match.blocked) {
      let since = null;
      let durationKnown = false;
      let workingDays = null;
      if (match.matchedOn === 'state') {
        const rule = convention.byType[item.type];
        since = currentSpellStart(getRevisionsFor(item.id), rule.states || []);
        durationKnown = since != null;
        workingDays = durationKnown ? workingDaysBetween(since, today) : null;
      }
      // FR-035-ii: a tag or field match carries no history, so its duration
      // is undeterminable — since/workingDays stay null and the item's
      // last-changed date is deliberately NOT substituted, which would
      // answer "when did anything last change" rather than "since when has
      // this been blocked".
      items.push({
        id: item.id,
        title: item.title,
        type: item.type,
        assignedTo: item.assignedTo,
        url: item.url,
        condition: 'blocked',
        matchedOn: match.matchedOn,
        since,
        durationKnown,
        workingDays,
      });
      continue; // FR-037: an item meeting both conditions appears once, as blocked
    }

    if (item.stateCategory === 'InProgress') {
      const workingDays = workingDaysBetween(item.changedDate, today);
      if (workingDays != null && workingDays > STALENESS_WORKING_DAYS) {
        items.push({
          id: item.id,
          title: item.title,
          type: item.type,
          assignedTo: item.assignedTo,
          url: item.url,
          condition: 'stalled',
          matchedOn: null,
          since: item.changedDate,
          durationKnown: true,
          workingDays,
        });
      }
    }
  }
  return { items };
}

module.exports = { computeImpediments, workingDaysBetween, currentSpellStart };
