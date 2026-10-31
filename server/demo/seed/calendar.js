/**
 * Every demo date is an offset from "today", so the data looks current
 * whenever the demo runs. The work week is Sunday to Thursday; Friday and
 * Saturday are the weekend.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKING_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'];

// The app counts days in UTC (its hours timeline, its week start), so "today" here is the UTC date,
// held as a local-midnight Date so every other helper keeps working in local getters.
function today(now = new Date()) {
  return new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function weekStart(d) {
  return addDays(d, -d.getDay());
}

function isWorkingDay(d) {
  return d.getDay() <= 4;
}

/** n working days after (or, when negative, before) d. d itself doesn't count. */
function addWorkingDays(d, n) {
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  let cur = d;
  while (left > 0) {
    cur = addDays(cur, step);
    if (isWorkingDay(cur)) left -= 1;
  }
  return cur;
}

/** Every working day from start to end inclusive. */
function workingDaysBetween(start, end) {
  const out = [];
  for (let cur = start; cur <= end; cur = addDays(cur, 1)) {
    if (isWorkingDay(cur)) out.push(cur);
  }
  return out;
}

/** Two-week sprints starting on Sundays; sprint `pastCount` contains today,
 * in its second week, so the current sprint already has a week of history. */
function sprints(todayDate, { count = 6, pastCount = 4, lengthDays = 14 } = {}) {
  const anchor = addDays(weekStart(todayDate), -7);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const start = addDays(anchor, (i - pastCount) * lengthDays);
    const finish = addDays(start, lengthDays - 1); // runs through the second Saturday
    out.push({ index: i, start, finish });
  }
  return out;
}

/** Local-midnight date → `YYYY-MM-DDT00:00:00Z`, the shape ADO uses for iteration dates. */
function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00Z`;
}

/** A timestamp on day d at the given hour (local), as an ISO string. */
function at(d, hour, minute = 0) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).toISOString();
}

module.exports = { DAY_MS, WORKING_DAYS, today, addDays, weekStart, isWorkingDay, addWorkingDays, workingDaysBetween, sprints, isoDate, at };
