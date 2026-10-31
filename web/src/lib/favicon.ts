export type FaviconTheme = 'light' | 'dark';

// Mirrors the --accent token in index.css (rgb(79 70 229) light /
// rgb(129 140 248) dark) so the tab icon reads as part of the app's own
// palette rather than a pasted-in logo. A simple geometric mark, not a
// reproduction of Microsoft's trademarked Azure artwork.
const ACCENT_HEX: Record<FaviconTheme, string> = {
  light: '4F46E5',
  dark: '818CF8',
};

function faviconHref(theme: FaviconTheme): string {
  const accent = ACCENT_HEX[theme];
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>` +
    `<rect width='32' height='32' rx='7' fill='%23${accent}'/>` +
    `<path d='M16 6 L25 26 L20 26 L16 16 L12 26 L7 26 Z' fill='%23ffffff'/>` +
    `</svg>`;
  return `data:image/svg+xml,${svg}`;
}

/** Swaps the browser tab icon for the given theme. The app themes off a
 * `.dark` class driven by localStorage (not prefers-color-scheme), so this
 * has to be called explicitly on load and on every theme toggle rather than
 * relying on a static `media` attribute on the <link>. */
export function applyFavicon(theme: FaviconTheme): void {
  let link = document.getElementById('favicon') as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = 'favicon';
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = faviconHref(theme);
}
