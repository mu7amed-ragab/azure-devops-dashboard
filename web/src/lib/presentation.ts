// Presentation mode hides the demo-data badge for screenshots. It is turned on
// with ?presentation=1 and off with ?presentation=0 on any URL, remembered for
// the tab (sessionStorage), and the parameter is removed from the address bar.
const KEY = 'presentation';

function readParam(): void {
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get(KEY);
    if (value === null) return;
    if (value === '1') sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
    params.delete(KEY);
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  } catch {
    // storage or history may be unavailable; the badge simply stays visible
  }
}

readParam();

export function isPresentation(): boolean {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}
