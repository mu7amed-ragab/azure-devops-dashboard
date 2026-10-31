/**
 * US4: remaining-work burndown for the selected sprint (FR-029 through
 * FR-034). Pure — server/scrum.js gathers the per-day remaining-work totals
 * from the revision index (which already forward-fills a field's value
 * across days it wasn't touched) and this module only adds the ideal
 * reference line and decides where the actual line stops. See data-model.md
 * §6.
 */

/** Every calendar date from `startDate` to `finishDate`, inclusive. */
function dateRange(startDate, finishDate) {
  const out = [];
  let d = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${finishDate}T00:00:00Z`);
  while (d.getTime() <= end.getTime()) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

/**
 * @param {string[]} dates one entry per calendar day of the sprint,
 *   ascending (dateRange's output).
 * @param {number[]} remainingByDate sum of RemainingWork across the sprint's
 *   items as of each date in `dates`, same length/order.
 * @param {boolean} tracked whether this project records RemainingWork on
 *   ANY of these items at all (FR-033) — decided by the caller from the
 *   index, not inferred from a day being zero.
 * @param {string} today ISO date (YYYY-MM-DD).
 */
function buildBurndown(dates, remainingByDate, tracked, today) {
  if (!tracked) return { points: [], tracked: false, todayIndex: -1 };

  let todayIndex = -1;
  for (let i = 0; i < dates.length; i++) {
    if (dates[i] <= today) todayIndex = i;
  }

  const start = remainingByDate[0] || 0;
  const totalDays = dates.length - 1;
  const points = dates.map((date, i) => ({
    date,
    // FR-031: actuals stop at today rather than dropping to the axis — a
    // day beyond today is null, distinct from a real 0.
    remaining: i <= todayIndex ? remainingByDate[i] : null,
    ideal: totalDays > 0 ? Math.max(0, start - (start * i) / totalDays) : start,
  }));

  return { points, tracked: true, todayIndex };
}

module.exports = { buildBurndown, dateRange };
