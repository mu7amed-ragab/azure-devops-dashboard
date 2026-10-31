/**
 * US6: what entered, left, and was re-estimated in the selected sprint after
 * it started, and the net effect on its size (FR-041 through FR-045a). Pure
 * over each story's `iterationPath` and `estimate` revision history — the
 * same item scope as velocity (FR-043a): every backlog-level (story-type)
 * item the project has ever revised. See data-model.md §8.
 */

/** @param {Array} revisions a story's revisions, ascending, each carrying
 *   `changedDate`, `iterationPath`, `estimate`, `workItemType`.
 *  @param {string} sprintPath
 *  @param {string} baselineDate the sprint's ADO start date (FR-044a) —
 *   the sole baseline; nothing about "when planning finished" is inferred.
 *  @param {string} endDate the sprint's finish date, or "now" if provisional.
 *  @param {(id:number, field:string, date:string) => any} getFieldAt
 *   SyncEngine.getFieldAt bound to this story's id — used to read the
 *   estimate at an arbitrary moment without re-deriving it from `revisions`.
 */
function eventsForStory(story, sprintPath, baselineDate, endDate, getFieldAt) {
  const revisions = story.revisions;
  const events = [];

  // Membership timeline: only the revisions where IterationPath is present,
  // deduped to actual transitions.
  const transitions = [];
  let lastPath;
  for (const r of revisions) {
    if (r.iterationPath == null || r.iterationPath === lastPath) continue;
    transitions.push({ date: r.changedDate, path: r.iterationPath });
    lastPath = r.iterationPath;
  }

  const wasInAtStart = getFieldAt(story.id, 'iterationPath', baselineDate) === sprintPath;
  let inSprint = wasInAtStart;
  let unestimated = false;

  for (const t of transitions) {
    if (t.date <= baselineDate || t.date > endDate) continue;
    if (t.path === sprintPath && !inSprint) {
      const est = getFieldAt(story.id, 'estimate', t.date);
      events.push({ storyId: story.id, title: story.title, date: t.date, kind: 'added', departureKind: null, previousEstimate: null, newEstimate: est, contribution: est || 0 });
      if (est == null) unestimated = true;
      inSprint = true;
    } else if (t.path !== sprintPath && inSprint) {
      const est = getFieldAt(story.id, 'estimate', t.date);
      const category = story.categoryAt ? story.categoryAt(t.date) : null;
      events.push({
        storyId: story.id,
        title: story.title,
        date: t.date,
        kind: 'departed',
        departureKind: category === 'Removed' ? 'removed' : 'moved',
        previousEstimate: est,
        newEstimate: null,
        contribution: -(est || 0),
      });
      inSprint = false;
    }
  }

  // Re-estimates: only while a member of the sprint (FR-042b), from the
  // value that applied when it joined (or the sprint started, whichever is
  // later) through to `endDate`. FR-042c/d: contribution is `new - previous`
  // and repeated changes are cumulative to `final - starting`, never the new
  // value whole.
  // Tracking must start at the EARLIEST moment the story was ever a member
  // during this window, not the latest. A story present at baseline that
  // later departs and is re-added still has exactly one 'added' event (from
  // the re-add) — unconditionally taking its date here would overwrite
  // `baselineDate` and silently drop every re-estimate made while the story
  // was in the sprint the FIRST time, before it departed. The per-revision
  // `stillIn` check below already excludes revisions from any interval the
  // story was actually out, so an early trackFrom is always safe.
  let trackFrom = wasInAtStart ? baselineDate : null;
  if (!wasInAtStart) {
    const addedEvent = events.find((e) => e.kind === 'added');
    if (addedEvent) trackFrom = addedEvent.date;
  }
  if (trackFrom) {
    let prevEstimate = getFieldAt(story.id, 'estimate', trackFrom);
    for (const r of revisions) {
      if (r.changedDate <= trackFrom || r.changedDate > endDate) continue;
      if (!('estimate' in r) || r.estimate === prevEstimate) continue;
      const stillIn = getFieldAt(story.id, 'iterationPath', r.changedDate) === sprintPath;
      const prev = prevEstimate;
      const next = r.estimate;
      // Keep tracking the CURRENT value even across a departed interval —
      // otherwise a story re-estimated WHILE OUT re-enters with `prevEstimate`
      // still pinned to its pre-departure value, and the first in-sprint
      // revision after re-entry double-counts a delta the departed/added
      // event pair (in the transitions loop above) already folded in.
      prevEstimate = next;
      if (!stillIn) continue; // no event for a change made while not a member — only the running comparison point moves
      if (prev == null && next == null) continue;
      // FR-042e: first estimate from zero/unset, or cleared to zero — both
      // fall out of the plain subtraction once null is treated as 0 for the
      // purpose of the delta (the event itself still records the true
      // previous/new values, null included).
      const contribution = (next || 0) - (prev || 0);
      if (contribution === 0) continue;
      events.push({ storyId: story.id, title: story.title, date: r.changedDate, kind: 're-estimated', departureKind: null, previousEstimate: prev, newEstimate: next, contribution });
    }
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { events, unestimated };
}

/**
 * @param {Array<{id, title, revisions, categoryAt}>} stories every
 *   story-level item the project has ever revised (same set as velocity).
 * @param {object} sprint {path, startDate, finishDate, status}
 * @param {(id:number, field:string, date:string) => any} getFieldAt
 * @param {string} today ISO date/timestamp — used as `endDate` when the
 *   sprint is still in progress (FR-043b).
 */
function computeScopeChange(stories, sprint, getFieldAt, today) {
  const endIsProvisional = sprint.status === 'current' || sprint.status === 'future';
  const endDate = endIsProvisional ? today : sprint.finishDate;

  let allEvents = [];
  let unestimatedCount = 0;
  for (const story of stories) {
    const { events, unestimated } = eventsForStory(story, sprint.path, sprint.startDate, endDate, getFieldAt);
    allEvents = allEvents.concat(events);
    if (unestimated) unestimatedCount += 1;
  }
  allEvents.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let sizeAtStart = 0;
  for (const story of stories) {
    if (getFieldAt(story.id, 'iterationPath', sprint.startDate) === sprint.path) {
      sizeAtStart += getFieldAt(story.id, 'estimate', sprint.startDate) || 0;
    }
  }
  const net = allEvents.reduce((sum, e) => sum + e.contribution, 0);
  const sizeAtEnd = sizeAtStart + net;

  return {
    determinable: true,
    baselineDate: sprint.startDate,
    sizeAtStart,
    sizeAtEnd,
    net,
    endIsProvisional,
    unestimatedCount,
    events: allEvents,
  };
}

module.exports = { computeScopeChange, eventsForStory };
