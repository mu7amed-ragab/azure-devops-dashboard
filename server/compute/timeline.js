/**
 * Azure DevOps has no timesheet. The honest source for "hours worked per
 * day" is the revision history of Microsoft.VSTS.Scheduling.CompletedWork:
 * each update records old -> new value with a changed-date. Summing positive
 * deltas per calendar day reconstructs a real hours-logged series.
 *
 * Revisions are immutable, so callers should cache per-workitem update
 * lists permanently and only fetch new work items' updates each sync.
 */

function dayKey(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function weekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // The work week here starts Sunday, which is already 0 in getUTCDay() —
  // so the day number needs no offset, just subtract it to land on Sunday.
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return dayKey(d);
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Azure DevOps stamps `revisedDate = 9999-01-01T00:00:00Z` on a work item's
 * *current* revision — it's a "this is the latest one" sentinel, not a real
 * date. Trusting it first silently discards the most recent day's work
 * (exactly what a "how much did I do today/yesterday" view needs most).
 * System.ChangedDate on the same revision is the real timestamp.
 */
function resolveRevisionDate(rev) {
  const changedDate = rev.fields && rev.fields['System.ChangedDate'] && rev.fields['System.ChangedDate'].newValue;
  if (changedDate) return changedDate;
  if (rev.revisedDate && !String(rev.revisedDate).startsWith('9999')) return rev.revisedDate;
  return null;
}

/**
 * Sums the NET change in CompletedWork per day. Counting only positive
 * deltas (the previous behaviour) meant a correction was silently
 * discarded: logging 1h and then undoing it left the +1 on the books
 * forever, inflating the day's total. Net deltas make corrections actually
 * subtract.
 *
 * A correction made on a *later* day reduces that later day rather than
 * the original one — an accepted approximation, since revisions only carry
 * the date the edit happened, not the day the work belonged to.
 *
 * @param {Array<{id:number, updates: Array<object>}>} workItemUpdates
 * @returns {Map<string, number>} dayKey -> net hours logged that day (>= 0)
 */
function buildDailyHours(workItemUpdates) {
  const daily = new Map();
  accumulateFromLegacyUpdates(daily, workItemUpdates.flatMap((w) => w.updates));
  clampDailyToNonNegative(daily);
  return daily;
}

/** `/updates` revisedBy carries an identity object, unlike the reporting
 * feed's legacy string — normalized to the same lowercased-email key so a
 * boundary-seeded item can be attributed consistently with an indexed one. */
function legacyRevisedByKey(revisedBy) {
  if (!revisedBy) return null;
  const email = revisedBy.uniqueName || revisedBy.mail || null;
  return email ? String(email).trim().toLowerCase() : null;
}

function addToPerItem(perItem, dayKeyValue, id, delta) {
  if (id == null) return;
  let byId = perItem.get(dayKeyValue);
  if (!byId) {
    byId = new Map();
    perItem.set(dayKeyValue, byId);
  }
  byId.set(id, (byId.get(id) || 0) + delta);
}

/**
 * 006-linked-identity-aliases: `personKey` accepts either a single lowercased
 * uniqueName (existing callers, unchanged) or a `Set` of them (one entry per
 * identity in the person's IdentitySet). A revision has exactly ONE author,
 * so testing set membership counts each revision at most once no matter how
 * many identities the set holds — there is no double-counting to guard
 * against here, unlike work items or PRs, which is why this widening needed
 * no further dedupe logic beyond this comparison.
 */
function matchesPersonKey(personKey, candidateKey) {
  if (!personKey) return true;
  if (personKey instanceof Set) return personKey.has(candidateKey);
  return personKey === candidateKey;
}

/** `personKey`, when given, restricts counted deltas to revisions made by
 * that person (matched against `revisedBy` via `legacyRevisedByKey`) — a
 * revision with no resolvable identity falls back to being counted anyway
 * (see buildDailyHoursFromIndex's own fallback for the same reasoning:
 * losing history silently is worse than occasionally over-attributing it). */
function accumulateFromLegacyUpdates(daily, updates, perItem = null, id = null, personKey = null) {
  for (const rev of updates) {
    const field = rev.fields && rev.fields['Microsoft.VSTS.Scheduling.CompletedWork'];
    if (!field || field.newValue === undefined) continue;
    if (personKey) {
      const revisedByKey = legacyRevisedByKey(rev.revisedBy);
      if (revisedByKey && !matchesPersonKey(personKey, revisedByKey)) continue;
    }
    const oldVal = Number(field.oldValue) || 0;
    const newVal = Number(field.newValue) || 0;
    const delta = newVal - oldVal;
    if (delta === 0) continue;
    const when = resolveRevisionDate(rev);
    if (!when) continue;
    const key = dayKey(new Date(when));
    daily.set(key, (daily.get(key) || 0) + delta);
    if (perItem) addToPerItem(perItem, key, id, delta);
  }
}

// Negative "hours worked" is meaningless to display, so a day whose
// corrections outweigh its logging floors at zero. Any per-item entries for
// that same day are dropped too, so the two stay consistent with each other.
function clampDailyToNonNegative(daily, perItem = null) {
  for (const [key, value] of daily) {
    if (value <= 0) {
      daily.delete(key);
      if (perItem) perItem.delete(key);
    }
  }
}

/**
 * Same net-delta, same daily clamp as `buildDailyHours`, but reading from
 * the shared revision index (server/ado/revisionIndex.js) instead of
 * per-item `/updates` payloads — this is what makes person-switching fast,
 * since the index is built once for the whole project rather than
 * per-person. The index reports the field's CURRENT value at every
 * revision, not just changed revisions, so a delta only exists where a
 * value actually differs from the previous one.
 *
 * `legacyUpdatesCache[id]`, when present, is used INSTEAD of the index for
 * that one item — this is the boundary-seeding fallback for items whose
 * true history starts before the index's coverage window (see
 * INDEX_START_DATE in revisionIndex.js), where the legacy `/updates` fetch
 * for just that item is the only way to get the real origin of an
 * already-nonzero value.
 *
 * @param {Map<number, Array<{rev:number, completedWork:number|null, changedDate:string|null, changedBy:string|null}>>} index
 * @param {number[]} ids
 * @param {Record<number, object[]>} legacyUpdatesCache
 * @param {string|Set<string>|null} personKey lowercased uniqueName (or, since
 *   006-linked-identity-aliases, a Set of them — one per identity in the
 *   person's IdentitySet) to attribute hours to. A delta belongs to whoever
 *   made the revision that produced it (`changedBy` on the later of the two
 *   revisions); a revision has exactly one author, so Set membership counts
 *   it at most once regardless of how many identities are in the set. An
 *   entry with no resolvable identity — a pre-rebuild leftover, or history
 *   that predates the field — falls back to being counted anyway rather than
 *   silently dropping real hours; the caller (sync.js) already scopes `ids`
 *   to items currently assigned to this person, so that fallback is
 *   "attribute by current assignee", the previous (imperfect but
 *   never-zero) behavior.
 * @returns {{ daily: Map<string, number>, perItem: Map<string, Map<number, number>> }}
 *   `perItem` mirrors `daily`, keyed the same way, but breaks each day's net
 *   hours down by work item id — the source data for a "what did I work on
 *   today" drill-down. Negative per-item deltas (a correction) are dropped
 *   rather than shown, matching the day-level clamp below.
 */
function buildDailyHoursFromIndex(index, ids, legacyUpdatesCache = {}, personKey = null) {
  const daily = new Map();
  const perItem = new Map();

  for (const id of ids) {
    if (legacyUpdatesCache[id]) {
      accumulateFromLegacyUpdates(daily, legacyUpdatesCache[id], perItem, id, personKey);
      continue;
    }
    const revs = index.get(id) || [];
    let prev = 0;
    for (const entry of revs) {
      const cur = entry.completedWork == null ? 0 : Number(entry.completedWork);
      const delta = cur - prev;
      if (delta !== 0 && entry.changedDate) {
        if (personKey && entry.changedBy && !matchesPersonKey(personKey, entry.changedBy)) {
          prev = cur;
          continue;
        }
        const key = dayKey(new Date(entry.changedDate));
        daily.set(key, (daily.get(key) || 0) + delta);
        addToPerItem(perItem, key, id, delta);
      }
      prev = cur;
    }
  }

  clampDailyToNonNegative(daily, perItem);
  return { daily, perItem };
}

function aggregate(daily, keyFn) {
  const out = new Map();
  for (const [day, hours] of daily.entries()) {
    const key = keyFn(new Date(day + 'T00:00:00Z'));
    out.set(key, (out.get(key) || 0) + hours);
  }
  return out;
}

function toSortedSeries(map) {
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([period, hours]) => ({ period, hours: Math.round(hours * 100) / 100 }));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Last N calendar days ending today (inclusive), zero-filled — a day with
 * no logged work is a real "0h" answer, not a gap to skip over. */
function lastNDaysZeroFilled(daily, n, today) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    const key = dayKey(d);
    out.push({ date: key, hours: round2(daily.get(key) || 0) });
  }
  return out;
}

/**
 * The current (or, on Fri/Sat, just-completed) Sunday-Thursday work week's
 * average hours per day, each day capped at 8h before averaging, plus that
 * average as a utilization percentage against an 8h day. The cap is applied
 * only here, at the read site — it must never mutate `daily` itself, since
 * every other Timeline figure (today, thisWeek, last7Days, ...) reads the
 * real, uncapped logged hours.
 *
 * Divisor is days ELAPSED in the work week, not a fixed 5 or 7: Sunday alone
 * is 1, Tuesday is 3, and Friday/Saturday both read 5 (the completed week),
 * so the figure never resets to an empty state over the weekend.
 *
 * @param {Map<string, number>} daily dayKey -> net hours
 * @param {Date} today UTC-midnight anchor for "now"
 * @returns {{weekStart: string, daysElapsed: number, hoursPerDay: number, utilizationPct: number}}
 */
function buildWeeklyAverage(daily, today) {
  const weekStart = weekKey(today);
  const weekStartDate = new Date(weekStart + 'T00:00:00Z');
  const dow = today.getUTCDay(); // Sunday=0 ... Saturday=6
  const daysElapsed = dow === 0 ? 1 : Math.min(dow + 1, 5);

  let sum = 0;
  for (let i = 0; i < daysElapsed; i++) {
    const d = new Date(weekStartDate);
    d.setUTCDate(d.getUTCDate() + i);
    const hours = daily.get(dayKey(d)) || 0;
    sum += Math.min(hours, 8);
  }
  const hoursPerDay = round2(sum / daysElapsed);
  const utilizationPct = Math.min(100, Math.round((hoursPerDay / 8) * 100));

  return { weekStart, daysElapsed, hoursPerDay, utilizationPct };
}

/** @param {Map<string, number>} daily dayKey -> net hours (from buildDailyHours or buildDailyHoursFromIndex) */
function buildTimeline(daily, now = new Date()) {
  const weekly = aggregate(daily, weekKey);
  const monthly = aggregate(daily, monthKey);

  const activeDays = daily.size;
  const totalHours = [...daily.values()].reduce((a, b) => a + b, 0);
  // Average over active days, not calendar days — calendar-day averaging
  // silently punishes weekends and reads as a false productivity decline.
  const averageDailyProductivity = activeDays > 0 ? round2(totalHours / activeDays) : 0;

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const todayKey = dayKey(today);
  const yesterdayKey = dayKey(yesterday);

  return {
    daily: toSortedSeries(daily),
    weekly: toSortedSeries(weekly),
    monthly: toSortedSeries(monthly),
    last7Days: lastNDaysZeroFilled(daily, 7, today),
    today: { date: todayKey, hours: round2(daily.get(todayKey) || 0) },
    yesterday: { date: yesterdayKey, hours: round2(daily.get(yesterdayKey) || 0) },
    thisWeek: { period: weekKey(today), hours: round2(weekly.get(weekKey(today)) || 0) },
    thisMonth: { period: monthKey(today), hours: round2(monthly.get(monthKey(today)) || 0) },
    weeklyAverage: buildWeeklyAverage(daily, today),
    averageDailyProductivity,
    activeDays,
    totalHours: round2(totalHours),
  };
}

/**
 * Per-day, per-work-item hours for a drill-down UI — restricted to the days
 * already present in `days` (the timeline's last7Days) so the payload stays
 * small rather than carrying the item's entire history. `itemLookup` fills
 * in title/type for display; an id missing from it (shouldn't happen, since
 * `perItem`'s ids are always a subset of what the caller fed into
 * `buildDailyHoursFromIndex`) falls back to a bare `#id` rather than
 * breaking the response.
 *
 * @param {Map<string, Map<number, number>>} perItem
 * @param {Array<{date: string}>} days
 * @param {Map<number, {title: string, type: string}>} itemLookup
 * @returns {Record<string, Array<{id:number, title:string, type:string, hours:number}>>}
 */
function buildBreakdown(perItem, days, itemLookup) {
  const breakdown = {};
  for (const { date } of days) {
    const byId = perItem.get(date);
    const entries = [];
    if (byId) {
      for (const [id, hours] of byId) {
        if (hours <= 0) continue; // corrections stay hidden, same as the day-level clamp
        const item = itemLookup.get(id);
        entries.push({
          id,
          title: item ? item.title : `#${id}`,
          type: item ? item.type : 'Unknown',
          hours: round2(hours),
        });
      }
      entries.sort((a, b) => b.hours - a.hours);
    }
    breakdown[date] = entries;
  }
  return breakdown;
}

module.exports = {
  buildDailyHours,
  buildDailyHoursFromIndex,
  buildTimeline,
  buildBreakdown,
  dayKey,
  weekKey,
  monthKey,
  matchesPersonKey,
};
