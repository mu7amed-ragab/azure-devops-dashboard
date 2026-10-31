const UNSCHEDULED_KEY = '__unscheduled__';

/**
 * Shared grouping engine: buckets any items with an `iterationPath` by
 * sprint, sorts each bucket with the caller's comparator, sorts sprints by
 * real start date (descending — string-sorting sprint names is wrong, e.g.
 * "Sprint 149" vs "Sprint 78"), and marks exactly one sprint `isLatest`
 * (the one with the greatest startDate). Used for both story-grouping and
 * PR-grouping so the sprint bucketing/ordering logic exists in exactly one
 * place.
 *
 * Items whose iteration can't be resolved — no IterationPath, or a path
 * outside this project's iteration tree (e.g. "UDC"), or a tree node with
 * no startDate (the project root is one) — are collected into one trailing
 * "No sprint" group instead of being dropped, so nothing disappears
 * silently. `droppedCount` is always 0; kept in the return shape so callers
 * don't need to change.
 */
function groupItemsByIteration(items, iterationMap, sortFn) {
  const groups = new Map();

  for (const item of items) {
    const key = item.iterationPath || UNSCHEDULED_KEY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const result = [];
  const unresolved = [];
  for (const [path, groupItems] of groups) {
    const meta = path === UNSCHEDULED_KEY ? null : iterationMap.get(path);
    if (!meta || !meta.startDate) {
      unresolved.push(...groupItems);
      continue;
    }
    result.push({
      iterationPath: path,
      iterationName: meta.name,
      startDate: meta.startDate,
      finishDate: meta.finishDate,
      isLatest: false,
      items: [...groupItems].sort(sortFn),
    });
  }

  result.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());

  // isLatest must land on the newest real sprint, decided before the
  // undated "No sprint" bucket is appended.
  if (result.length > 0) result[0].isLatest = true;

  if (unresolved.length > 0) {
    result.push({
      iterationPath: null,
      iterationName: 'No sprint',
      startDate: null,
      finishDate: null,
      isLatest: false,
      items: [...unresolved].sort(sortFn),
    });
  }

  return { groups: result, droppedCount: 0 };
}

module.exports = { groupItemsByIteration };
