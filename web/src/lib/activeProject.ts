/**
 * Which project this browser is currently signed in to, as a key for
 * everything persisted in localStorage.
 *
 * The dashboard is now per project, but the client's persisted state — filters,
 * grouping, the selected sprint, the last-known-good dashboard payload — was
 * written when there was only ever one. Without namespacing, signing in to a
 * second project would repaint project A's cached payload and reapply its
 * sprint selection to project B's data.
 *
 * Set from RequireAuth (synchronously, before any consumer renders) rather than
 * read from a hook, because the consumers read localStorage during their own
 * initial render — a hook would be one render too late.
 */

let activeKey = 'none';

export function setActiveProjectKey(key: string | null | undefined): void {
  const next = key || 'none';
  if (next !== activeKey) activeKey = next;
}

export function activeProjectKey(): string {
  return activeKey;
}

/**
 * A React Query key with the active project as its first segment.
 *
 * Every server payload behind these keys is project-scoped — the dashboard,
 * work item states, the roster, the org chart, the PR pages — so the key that
 * caches it has to be too. Both ways of switching project (the account menu's
 * Switch project row, and signing out) end in a full page load, which throws
 * the in-memory query cache away, so nothing leaks across a switch in
 * practice; scoping the keys is what makes that a property
 * of the cache rather than a lucky consequence of how switching happens to be
 * implemented. It also means `invalidateQueries({ queryKey: ['project'] })`
 * would drop exactly the project-dependent half of the cache and nothing else.
 */
export function projectQueryKey(...parts: (string | number | null)[]): (string | number | null)[] {
  return ['project', activeProjectKey(), ...parts];
}
