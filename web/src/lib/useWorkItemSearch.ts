import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchWorkItems } from './api';
import { projectQueryKey } from './activeProject';
import type { PastOwnedResult } from './types';

const DEBOUNCE_MS = 350;
const MIN_QUERY_LENGTH = 2;

/**
 * Debounced search over items the person USED to own — a project-scoped read
 * against GET /api/workitems/search. Deliberately a SEPARATE React Query
 * entry from the dashboard (research.md R2): nothing about the unsearched
 * view or its counts depends on this hook ever having run.
 *
 * `rawQuery` is whatever the search box currently holds; the request itself
 * only fires once it's stopped changing for DEBOUNCE_MS and is at least
 * MIN_QUERY_LENGTH characters — below that, no ADO call is made at all
 * (mirrors /api/people/search's own 2-character floor).
 */
export function useWorkItemSearch(rawQuery: string, personId?: string | null) {
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const trimmed = rawQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setDebounced('');
      return;
    }
    const handle = setTimeout(() => setDebounced(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [rawQuery]);

  const enabled = debounced.length >= MIN_QUERY_LENGTH;

  const query = useQuery({
    queryKey: projectQueryKey('workitem-search', personId ?? 'self', debounced),
    queryFn: () => searchWorkItems(debounced, personId ?? null),
    enabled,
    // A response for a query the user has since changed is worthless even if
    // it lands late — React Query already keys by `debounced`, so a stale
    // fetch resolves into a query key nobody's reading; this is the explicit
    // belt-and-braces check the contract calls out (`query` on the response
    // must match what's being asked for).
    select: (data) => (data.query === debounced ? data : { results: [] as PastOwnedResult[], truncated: false, query: debounced }),
  });

  return {
    results: query.data?.results ?? [],
    truncated: query.data?.truncated ?? false,
    isSearching: enabled,
    isPending: enabled && query.isFetching,
    isError: query.isError,
  };
}
