/*
 * DIRECTION CONTRACT — The Ambient Canopy
 * THESIS: The Color-Coded Ledger gets a window — the instrument stays flat,
 *   dense and semantic; the room it sits in gets weather. Refuses the
 *   category default of a dashboard on flat #111.
 * OWN-WORLD: existing tokens only. Dark: indigo-black wash, two nebula
 *   blooms, tiled starfields, rare shooting stars. Light: pale dawn wash,
 *   one warm sun bloom, a faint ray fan, three slow-drifting cloud bands.
 * FIRST VIEWPORT: sky fills the viewport; a frosted content pane floats
 *   over it; the sky is felt in the gutters, never competing with data.
 * FORM: brief-pinned world (sky + clouds named by the user) — an extension
 *   of the established login identity, not a concept tournament.
 * FINISH: unreviewed and undocumented is unfinished; this build ends with
 *   the finish review, the verdict, and DESIGN.md.
 *
 * Shared by the app shell (Layout.tsx) and the login screen (LoginPage.tsx)
 * — see DESIGN.md "The Ambient Canopy". Purely decorative: aria-hidden,
 * pointer-events-none, fixed (never scrolls/repaints with content).
 */

interface Star {
  top: string;
  left: string;
  size: number;
  delay: number;
  duration: number;
}

// Hand-placed rather than randomized: a fixed layout renders identically on
// every visit and every server-rendered/client mismatch is a non-issue.
const STARS: Star[] = [
  { top: '8%', left: '14%', size: 2, delay: 0, duration: 3.2 },
  { top: '13%', left: '82%', size: 1.5, delay: 0.7, duration: 4.1 },
  { top: '19%', left: '46%', size: 1.5, delay: 1.4, duration: 3.6 },
  { top: '24%', left: '68%', size: 2, delay: 0.3, duration: 4.6 },
  { top: '28%', left: '8%', size: 1.5, delay: 2.1, duration: 3.9 },
  { top: '34%', left: '92%', size: 1.5, delay: 1.1, duration: 3.3 },
  { top: '41%', left: '25%', size: 2, delay: 1.8, duration: 4.3 },
  { top: '47%', left: '58%', size: 1.5, delay: 0.5, duration: 3.7 },
  { top: '55%', left: '11%', size: 1.5, delay: 2.5, duration: 4.0 },
  { top: '62%', left: '76%', size: 2, delay: 0.9, duration: 3.4 },
  { top: '68%', left: '38%', size: 1.5, delay: 1.6, duration: 4.4 },
  { top: '74%', left: '90%', size: 1.5, delay: 0.2, duration: 3.8 },
  { top: '81%', left: '20%', size: 2, delay: 2.3, duration: 3.5 },
  { top: '88%', left: '62%', size: 1.5, delay: 1.2, duration: 4.2 },
];

export function AmbientSky() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      {/* Dark layer — night sky, quieter than the original login-only version
          since it now sits behind every screen, not just a one-time threshold. */}
      <div className="hidden dark:block">
        <div className="absolute inset-0 bg-gradient-to-b from-[#05050a] via-[#0a0a17] to-[#0d0a1c]" />
        <div className="absolute -start-32 -top-32 h-96 w-96 rounded-full bg-accent/12 blur-[110px]" />
        <div className="absolute -end-40 bottom-0 h-[28rem] w-[28rem] rounded-full bg-type-sprint/12 blur-[130px]" />

        <div className="star-field-far absolute inset-0" />
        <div className="star-field-near absolute inset-0" />

        {STARS.map((s, i) => (
          <span
            key={i}
            className="animate-star-twinkle absolute rounded-full bg-white"
            style={{
              top: s.top,
              left: s.left,
              width: s.size,
              height: s.size,
              animationDelay: `${s.delay}s`,
              animationDuration: `${s.duration}s`,
            }}
          />
        ))}

        <span
          className="animate-shooting-star absolute opacity-0 left-[72%] top-[14%] h-px w-24 rounded-full bg-gradient-to-r from-transparent via-white to-transparent"
          style={{ animationDuration: '34s', animationDelay: '4s' }}
        />
        <span
          className="animate-shooting-star absolute opacity-0 left-[28%] top-[30%] h-px w-16 rounded-full bg-gradient-to-r from-transparent via-white to-transparent"
          style={{ animationDuration: '51s', animationDelay: '18s' }}
        />
      </div>

      {/* Light layer — dawn sky, sun bloom, drifting cloud bands. */}
      <div className="dark:hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-[#eef3fb] via-[#f8fafd] to-[#fdf7ef]" />
        <div className="absolute -end-24 -top-24 h-[26rem] w-[26rem] rounded-full bg-warning-tint/20 blur-[120px]" />
        <div className="sun-rays absolute -end-1/4 -top-1/4 h-[150%] w-[150%]" />

        <div className="cloud-band-a absolute inset-x-[-20%] top-[12%] h-24" />
        <div className="cloud-band-b absolute inset-x-[-20%] top-[42%] h-32" />
        <div className="cloud-band-c absolute inset-x-[-20%] top-[70%] h-20" />
      </div>

      {/* Scrim — damps the sky's brightest points before the content pane's
          own translucency is applied, keeping published contrast ratios
          honest against the actual text (see DESIGN.md). */}
      <div className="absolute inset-0 bg-surface/45" />
    </div>
  );
}

