import { QueryClient } from '@tanstack/react-query';
import { activeProjectKey } from './activeProject';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// v4: `repoPrGroups` (full PR bodies) replaced by `prRepos` (per-repo
// summaries, no PR bodies — see lib/prPaging.ts and GET /api/pullrequests)
// — bumped so a stale-shaped localStorage payload isn't revived into
// initialData.
// v5: keys are namespaced by project. Bumped rather than migrated because a
// v4 payload can't be attributed to a project after the fact, and repainting
// one project's dashboard under another is worse than one cold load.
const CACHE_PREFIX = 'azure-dashboard-cache-v5';

interface Persisted<T> {
  data: T;
  savedAt: number;
}

function cacheKey(personKey: string): string {
  return `${CACHE_PREFIX}:${activeProjectKey()}:${personKey}`;
}

/** Instant cold paint from the last known-good payload, before the network
 * round trip resolves. Returns the timestamp it was saved at alongside the
 * data — without that, React Query has no way to know the seeded data is
 * old, treats it as fresh for a full staleTime window on every load, and
 * skips refetching (this was why a refresh could show stale numbers: only
 * a browser with no cached copy fetched immediately). */
export function loadPersistedDashboard<T>(personKey: string): Persisted<T> | undefined {
  try {
    const raw = localStorage.getItem(cacheKey(personKey));
    return raw ? (JSON.parse(raw) as Persisted<T>) : undefined;
  } catch {
    return undefined;
  }
}

export function persistDashboard(personKey: string, data: unknown): void {
  try {
    const payload: Persisted<unknown> = { data, savedAt: Date.now() };
    localStorage.setItem(cacheKey(personKey), JSON.stringify(payload));
  } catch {
    // best-effort; localStorage may be full or disabled
  }
}
