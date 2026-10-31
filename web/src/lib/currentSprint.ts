import { create } from 'zustand';
import { activeProjectKey } from './activeProject';
import type { IterationGroup } from './types';

// Shares the `azure-dashboard-ui:v1` prefix used by persistedState.ts so the
// Clear Cache reset sweep (localReset.ts) picks it up along with every
// other filter/grouping key, and is namespaced by project for the same reason
// those keys are: a sprint pick belongs to one project's iterations.
function key(): string {
  return `azure-dashboard-ui:v1:${activeProjectKey()}:current-sprint`;
}

function readPath(): string | null {
  try {
    const raw = localStorage.getItem(key());
    return raw === null ? null : (JSON.parse(raw) as string | null);
  } catch {
    return null;
  }
}

function writePath(path: string | null): void {
  try {
    localStorage.setItem(key(), JSON.stringify(path));
  } catch {
    // best-effort; localStorage may be full or disabled
  }
}

interface CurrentSprintState {
  /** The manually-marked current sprint's iterationPath, or null to defer
   * to the server's `isLatest` pick. Global across the whole dashboard
   * (My Work Items and every Team member share one selection), so it lives
   * in a store rather than the per-scope usePersistedState used elsewhere —
   * multiple WorkItemsView instances can be mounted at once on the Team
   * page and must all react to the same change immediately. */
  path: string | null;
  /** Marks `path` as current; calling it again with the same path clears
   * the selection (toggle), falling back to `isLatest`. */
  setCurrent: (path: string | null) => void;
}

export const useCurrentSprintStore = create<CurrentSprintState>((set, get) => ({
  // Deliberately not seeded here: this module can be imported before the
  // active project is known, and the storage key depends on it. RequireAuth
  // calls hydrateCurrentSprint() as soon as it is.
  path: null,
  setCurrent: (path) => {
    const next = get().path === path ? null : path;
    writePath(next);
    set({ path: next });
  },
}));

let hydratedFor: string | null = null;

/** Loads the marked sprint for whichever project is now active — called from
 * RequireAuth after the project key is set, and again on a project change. */
export function hydrateCurrentSprint(): void {
  const projectKey = activeProjectKey();
  if (hydratedFor === projectKey) return;
  hydratedFor = projectKey;
  useCurrentSprintStore.setState({ path: readPath() });
}

/** True when today falls inside this sprint's own date range. Dates are
 * compared date-only (`YYYY-MM-DD`), the same way server/sync.js decides a
 * sprint's `current` status, so a sprint counts as current for the whole of
 * its last day regardless of the time component ADO stored. */
function containsToday(group: IterationGroup, today: string): boolean {
  if (!group.startDate || !group.finishDate) return false;
  const start = group.startDate.slice(0, 10);
  const finish = group.finishDate.slice(0, 10);
  return today >= start && today <= finish;
}

/** The sprint that should be treated as current absent a manual pick: the
 * one whose start–finish range contains today, falling back to whichever
 * the server marked `isLatest` (the newest by start date) when today sits
 * in a gap between sprints, or after the last one. */
export function defaultCurrentPath(groups: IterationGroup[]): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const active = groups.find((g) => containsToday(g, today));
  if (active) return active.iterationPath;
  return groups.find((g) => g.isLatest)?.iterationPath ?? null;
}

/** Resolves the effective current sprint: the manually-marked one when it's
 * present in this data, otherwise the date-based default above. */
export function resolveCurrentPath(
  groups: IterationGroup[],
  markedPath: string | null
): string | null {
  if (markedPath !== null && groups.some((g) => g.iterationPath === markedPath)) return markedPath;
  return defaultCurrentPath(groups);
}

/** A sprint is "current" if it's the manually-marked one, or — absent a
 * manual pick, or if the marked sprint isn't present in this data (e.g.
 * filtered out server-side) — the one containing today, per
 * `resolveCurrentPath`. Pass the already-resolved path from
 * `resolveCurrentPath` so every group in a list agrees on one answer. */
export function isCurrentGroup(group: IterationGroup, currentPath: string | null): boolean {
  return currentPath !== null && group.iterationPath === currentPath;
}

/** Reorders groups so the current sprint leads, keeping the rest in the
 * server's original order. A no-op when there's no manual pick or the
 * picked sprint isn't present in `groups`. */
export function orderGroups(groups: IterationGroup[], currentPath: string | null): IterationGroup[] {
  if (currentPath === null) return groups;
  const idx = groups.findIndex((g) => g.iterationPath === currentPath);
  if (idx <= 0) return groups;
  const copy = groups.slice();
  const [current] = copy.splice(idx, 1);
  copy.unshift(current);
  return copy;
}
