// Every persisted UI setting lives in localStorage across a few prefixes
// (azure-dashboard-ui:v1:*, azure-dashboard-cache-v3:*, plus older/future
// ones) — rather than enumerate keys and risk missing a namespace, Clear
// Cache sweeps the whole of localStorage and keeps only what's explicitly
// exempted.
const KEEP = new Set(['theme']);

// UserChip reloads the page ~800ms after clearing the server cache while
// components are still mounted, so clearing localStorage immediately would
// race their usePersistedState effects writing keys back out. Flagging the
// reset and applying it before the app mounts on the next load avoids that
// race entirely.
const RESET_FLAG = 'azure-dashboard:reset-pending';

export function requestLocalReset(): void {
  try {
    sessionStorage.setItem(RESET_FLAG, '1');
  } catch {
    // best-effort; sessionStorage may be disabled
  }
}

export function applyPendingLocalReset(): void {
  try {
    if (sessionStorage.getItem(RESET_FLAG) !== '1') return;
    sessionStorage.removeItem(RESET_FLAG);
    for (const key of Object.keys(localStorage)) {
      if (!KEEP.has(key)) localStorage.removeItem(key);
    }
  } catch {
    // best-effort; storage may be disabled
  }
}
