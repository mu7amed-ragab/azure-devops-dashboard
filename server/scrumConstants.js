/**
 * Every tunable this feature depends on, in one place, each cited to where
 * the spec states it. Every consumer reads from here — no comparison
 * against a band and no stage-progress literal may appear anywhere else.
 */

// spec Assumptions, "New to this revision". FR-038 requires only that
// staleness be counted in working days; this fixes the number.
const STALENESS_WORKING_DAYS = 3;

// spec Assumptions, "Carried forward from revision 1". FR-011 requires only
// that the average follow the window; this fixes its size.
const DEFAULT_SPRINT_WINDOW = 6;

// spec Assumptions, "New to this revision". FR-029 requires only that
// remaining work be plotted per day; this fixes the unit.
const BURNDOWN_UNIT = 'hours';

// FR-024, FR-024a — stated normatively.
const UTILISATION_OVER = 1.1;
const UTILISATION_UNDER = 0.7;

// FR-017 — keyed on the ADO category ADO returns, never on a state name
// (FR-005).
const STAGE_PROGRESS_BY_CATEGORY = { Proposed: 0, InProgress: 0.5, Resolved: 0.9, Completed: 1 };

module.exports = {
  STALENESS_WORKING_DAYS,
  DEFAULT_SPRINT_WINDOW,
  BURNDOWN_UNIT,
  UTILISATION_OVER,
  UTILISATION_UNDER,
  STAGE_PROGRESS_BY_CATEGORY,
};
