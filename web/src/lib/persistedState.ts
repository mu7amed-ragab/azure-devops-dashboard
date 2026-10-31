import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { activeProjectKey } from './activeProject';

const PREFIX = 'azure-dashboard-ui:v1';

/** Namespaced by project: filters and selections are about one project's data,
 * so signing in to another must not inherit them (see lib/activeProject.ts). */
function storageKey(key: string): string {
  return `${PREFIX}:${activeProjectKey()}:${key}`;
}

function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(storageKey(key));
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
}

function write<T>(key: string, value: T): void {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // best-effort; localStorage may be full or disabled
  }
}

/** Same signature and semantics as useState, but seeded from localStorage
 * and written back on every change. All reads/writes are best-effort: a
 * disabled or full localStorage degrades to plain component state rather
 * than throwing (same posture as loadPersistedDashboard). If `key` changes
 * for an already-mounted component, re-seeds from the new key. */
export function usePersistedState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => read<T>(key) ?? initial);
  const [seededKey, setSeededKey] = useState(key);

  if (key !== seededKey) {
    setSeededKey(key);
    setState(read<T>(key) ?? initial);
  }

  useEffect(() => {
    write(key, state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state]);

  return [state, setState];
}

/** Set-valued variant — Sets don't survive JSON, so this stores an array and
 * revives it. Every filter and selection in the app is a Set. */
export function usePersistedSet<T extends string | number>(key: string): [Set<T>, Dispatch<SetStateAction<Set<T>>>] {
  const [state, setState] = useState<Set<T>>(() => new Set(read<T[]>(key) ?? []));
  const [seededKey, setSeededKey] = useState(key);

  if (key !== seededKey) {
    setSeededKey(key);
    setState(new Set(read<T[]>(key) ?? []));
  }

  useEffect(() => {
    write(key, [...state]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, state]);

  return [state, setState];
}
