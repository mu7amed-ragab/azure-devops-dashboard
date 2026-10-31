---
name: Azure Dashboard
description: A dense, calm work-tracking instrument where color always encodes meaning — never decoration.
colors:
  surface: "rgb(255 255 255)"
  surface-raised: "rgb(250 250 251)"
  surface-sunken: "rgb(244 244 246)"
  border: "rgb(228 228 232)"
  ink: "rgb(23 23 28)"
  ink-muted: "rgb(100 100 112)"
  ink-subtle: "rgb(113 113 126)"
  accent: "rgb(79 70 229)"
  accent-hover: "rgb(67 56 202)"
  success: "rgb(4 120 87)"
  warning: "rgb(180 83 9)"
  danger: "rgb(190 18 60)"
  info: "rgb(29 78 216)"
  success-tint: "rgb(16 185 129)"
  warning-tint: "rgb(245 158 11)"
  danger-tint: "rgb(244 63 94)"
  info-tint: "rgb(59 130 246)"
  type-story: "rgb(59 130 246)"
  type-task: "rgb(217 119 6)"
  type-bug: "rgb(244 63 94)"
  type-sprint: "rgb(139 92 246)"
  stage-approved: "rgb(13 148 136)"
  stage-review: "rgb(124 58 237)"
  stage-staging: "rgb(147 51 234)"
  stage-intake: "rgb(8 145 178)"
typography:
  display:
    fontFamily: "InterVariable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
  title:
    fontFamily: "InterVariable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  section:
    fontFamily: "InterVariable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "InterVariable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.5
  label:
    fontFamily: "InterVariable, Inter, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "10px"
  full: "9999px"
spacing:
  sm: "8px"
  md: "12px"
  lg: "16px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  pill-static:
    rounded: "{rounded.full}"
    padding: "2px 8px"
  pill-interactive:
    rounded: "{rounded.full}"
    padding: "4px 8px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
---

# Design System: Azure Dashboard

## Overview

**Creative North Star: "The Color-Coded Ledger"**

Azure Dashboard is a dense, calm instrument for tracking work, not a marketing surface — its personality comes from precision, not decoration. Every hue on screen is load-bearing: it names a work item type, a workflow stage, or a status, and nothing is colored "just because." The layout stays flat and quiet at rest — surfaces are tonal, not shadowed — so the one deliberately loud gesture (the 4px colored spine on every card) reads as a signal against a calm field instead of competing noise.

The system rejects two failure modes explicitly: decorative color (a hue chosen for vibe rather than meaning) and silent severity inflation (a warning or error state that doesn't actually clear contrast floors). Every status and type color in this system carries a measured contrast ratio against the surface it sits on, in both themes.

**Key Characteristics:**
- Color is semantic, never decorative — see The Coding Rule.
- Flat by default; depth comes from tonal layering, not shadow.
- One accent bar per card — the "spine" — is the system's signature gesture.
- Dense information layout: small type, tight rhythm, built for scanning many items at once.

## Colors

The palette is built from four families, each carrying a specific kind of meaning rather than a mood.

### Primary
- **Indigo Accent** (`rgb(79 70 229)` / dark: `rgb(129 140 248)`): the one interactive/selection color — active nav, focus rings, primary buttons, "current" markers. Used sparingly; if it appears, it means "this is selected, active, or actionable."

### Secondary — Status
- **Success Emerald** (`rgb(4 120 87)` text / `rgb(16 185 129)` tint): closed, deployed, completed states.
- **Warning Amber** (`rgb(180 83 9)` text / `rgb(245 158 11)` tint): on-hold, sprint-mismatch, threshold-crossing states.
- **Danger Rose** (`rgb(190 18 60)` text / `rgb(244 63 94)` tint): blocked tasks, bugs, errors, abandoned PRs.
- **Info Blue** (`rgb(29 78 216)` text / `rgb(59 130 246)` tint): active/in-progress states.

### Tertiary — Work Item Coding & Workflow Stage
- **Story Blue** (`rgb(59 130 246)`), **Task Amber** (`rgb(217 119 6)`), **Bug Rose** (`rgb(244 63 94)`), **Sprint Violet** (`rgb(139 92 246)`): the spine/tint colors on every card, keyed to work item type. Sprint violet is deliberately excluded from the three item colors so a sprint header never reads as "a story."
- **Stage hues** — Intake Cyan (`rgb(8 145 178)`), Approved Teal (`rgb(13 148 136)`), Review Violet (`rgb(124 58 237)`), Staging Purple (`rgb(147 51 234)`): the mid-pipeline workflow states that aren't already covered by a status color.

### Neutral
- **Dark is the default theme** (`web/index.html`'s pre-paint script defaults to `dark` rather than following `prefers-color-scheme`); the header sun/moon toggle is the only way to light mode, and the choice persists to `localStorage`.
- **Surface** (`rgb(255 255 255)` / dark `rgb(17 17 22)`): page background.
- **Surface Raised** (`rgb(250 250 251)` / dark `rgb(24 24 30)`): toolbars, stat tiles, popovers.
- **Surface Sunken** (`rgb(244 244 246)` / dark `rgb(12 12 16)`): input fields, inset panels.
- **Border** (`rgb(228 228 232)` / dark `rgb(40 40 48)`): all hairline dividers and card borders.
- **Ink** (`rgb(23 23 28)` / dark `rgb(237 237 242)`): primary text.
- **Ink Muted** (`rgb(100 100 112)` / dark `rgb(168 168 180)`): secondary text, metadata.
- **Ink Subtle** (`rgb(113 113 126)` / dark `rgb(140 140 153)`): the dimmest text tier that still clears 4.5:1 — measured, not assumed (see the token comments in `index.css`).

### Named Rules
**The Coding Rule.** If a hue appears on screen and it doesn't encode a work item type, a workflow stage, or a status, it's a bug. There is no purely decorative color in this system. One documented exception exists — see The Ambient Canopy, below.

**The Two-Tier Rule.** Every status/type color has two forms: a `-tint` used at 15% alpha for fills and pills, and a full-strength base used for text and icons. Never use the tint value for text — it was never contrast-checked for that role.

## Typography

**Body Font:** InterVariable (self-hosted via `@fontsource-variable/inter`), falling back to `Inter, system-ui, -apple-system, Segoe UI, sans-serif`.

**Character:** A single variable-weight grotesque used for everything — display numbers, body text, and metadata alike — differentiated by size and weight rather than by switching families. Loaded locally so the Windows/macOS fleet this app runs on renders identically instead of falling back to Segoe UI or SF Pro.

### Hierarchy
- **Display** (600, 1.5rem / `text-2xl`, 1.2): stat tile values and the hours-strip figures — the numbers a user scans for first.
- **Title** (600, 1.125rem / `text-lg`, 1.3): the page `<h1>` — Dashboard, Work Items, Pull Requests, Team.
- **Section** (600, 0.875rem / `text-sm`, 1.4): section headers (`<h2>`) and container titles — sprint names, repo names, teammate names, story titles.
- **Body** (500, 0.875rem / `text-sm`, 1.5): item titles — task titles, PR titles.
- **Label** (500, 0.75rem / `text-xs`, 1.4): metadata — dates, counts, hours, badges. The smallest step in the scale; nothing renders below it.

### Named Rules
**The Two-Weight Rule.** Container titles (sprint, repo, teammate, story) are `font-semibold`; item titles nested inside them (task, PR) are `font-medium`. The weight step itself signals nesting depth, independent of size.

## Layout

A single-column, max-width-6xl shell (`Layout.tsx`) with a sticky header and a `space-y-{4,6}` page rhythm. Cards nest to mirror the real work-item hierarchy — sprint → story → task — rather than as decorative containerization; each nesting level is a real parent/child relationship in Azure DevOps. Toolbars (search + filter chips + view menus) are a single shared shape (`ui/Toolbar.tsx`) reused verbatim across every list page rather than four near-identical inline bars. Density is intentionally high: `text-xs`/`text-sm` throughout, `gap-2`/`gap-3` rhythm, built for scanning dozens of work items per screen rather than a handful.

## Elevation & Depth

Flat by default. Surfaces are distinguished by tone (`surface` → `surface-raised` → `surface-sunken`), not shadow — most cards, toolbars, and rows carry a 1px `border` and no `box-shadow` at rest. Since The Ambient Canopy (below), the app shell itself is a translucent, blurred pane (`bg-surface/85 backdrop-blur-xl`) floating over the fixed sky rather than a bare `bg-surface` — every card and toolbar inside it keeps its own opaque `surface`-based background, so this doesn't change any measured contrast ratio, only what sits behind the pane's own edges.

### Shadow Vocabulary
- **Popover** (`shadow-lg`): the one shadow role in the system, reserved for anchored overlays that visually float above the page — dropdowns, menus, the account panel. Never used on inline cards.

### Named Rules
**The Flat-By-Default Rule.** Shadows appear only on elements that are genuinely floating above the layout (popovers, the fixed cumulative-progress bar). A card sitting in its normal document position never gets one, no matter how much it needs to stand out — that job belongs to the border and tint, not a shadow. The login screen's card shadow/glow is the one exception — see The Ambient Canopy.

## Shapes

Two radius steps carry the whole system: `rounded-card` (10px) for cards, panels, and popovers; `rounded-md` (6px) for buttons, inputs, and menu items; `rounded-full` for pills and circular avatar/icon buttons. Borders are hairline (1px, the `border` neutral token) everywhere except the signature spine.

### Named Rules
**The Spine Rule.** Every story, task, and sprint-group card carries a 4px full-hue left accent bar (`ui/AccentBar.tsx`) — deliberately thicker than this system's own 1px default-border floor. This is the one place the system breaks its own flatness/thinness defaults on purpose: the spine is the fastest way to identify a card's type across a dense page of similarly-shaped cards, and its color is never arbitrary (see The Coding Rule). It is kept and documented as earned, not an unaudited leftover.

## The Ambient Canopy

The whole app sits on a decorative, fixed background (`components/AmbientSky.tsx`) — a
night sky with stars and rare shooting stars in dark mode, a dawn sky with a sun bloom and
slow-drifting clouds in light mode. This is the system's single documented exception to
The Coding Rule: none of it encodes a work item type, a workflow stage, or a status. It
supersedes the old, narrower "Threshold Exception" (the login screen was once the only
surface allowed this); the sky is now behind every route, kept and documented as earned,
the same posture as The Spine Rule, not an unaudited leftover.

**Why the whole app, not just login.** The instrument itself — cards, pills, chips, the
spine — stays exactly as flat and semantic as before; nothing about this rule loosens The
Coding Rule for anything drawn *inside* the content pane. What changed is only the room the
instrument sits in. The sky is fixed and lives behind a scrim and a translucent-but-measured
pane (see Elevation & Depth), so it is felt in the gutters, never in competition with the
data.

**What stays in bounds:**
- Every color used is one of the system's own tokens (`--accent`, `--type-sprint`,
  `--warning-tint`) — no new hue was added to the palette to build this.
- `fixed`, `aria-hidden`, and `pointer-events-none` — the sky never scrolls, never
  intercepts a click, and never reaches assistive tech.
- Motion budget: nothing under 3s. Twinkling stars run 3.2–4.6s, cloud bands run
  140–240s, shooting stars run 34–51s. Transform/opacity only — no animation loop, no
  `requestAnimationFrame`. Every keyframe's `100%` frame is visible, per the same
  `prefers-reduced-motion` reasoning documented in `index.css` (a fade-to-zero keyframe
  would leave reduced-motion users on a blank frame instead of a held one).
- A scrim (`bg-surface/45`) plus the content pane's own translucency (`bg-surface/85` on
  the app shell, `bg-surface-raised/70` on the login card) keep every contrast ratio this
  system has measured against `surface`/`surface-raised` holding against the actual text —
  the pane's alpha is the dial if that ever needs adjusting, never the token values.
- The login screen (`features/auth/LoginPage.tsx`) keeps one further exception beyond the
  sky itself: its avatar glow and glass card (`bg-surface-raised/70 backdrop-blur-2xl`,
  a `border-white/10` hairline, a top highlight). Always dark there (`.login-night`,
  sharing `.dark`'s CSS variables verbatim rather than a second, unaudited set) — see
  Colors/Neutral for why those values are already contrast-checked.
- No other screen may adopt a gradient-clipped title, a glow, or a shadow on an inline
  element — that stays scoped to the login card, and would turn a documented exception
  into silent drift anywhere else.

## Components

### Buttons
- **Shape:** `rounded-md` (6px), `px-3 py-1.5`, `text-xs font-medium`.
- **Primary** (`ui/PrimaryButton.tsx`): `bg-accent` / white text. **Hover:** `bg-accent-hover` (the one hover state the pre-audit implementation was missing on all 3 instances). **Disabled:** `opacity-40`.
- **Icon-only** (`ui/IconButton.tsx`): 24×24px (`h-6 w-6`), `rounded-md`, the WCAG 2.2 AA pointer-target floor. One shared hover idiom (`hover:bg-surface-sunken hover:text-ink`) across all 9 previously-divergent icon buttons.

### Pills (`ui/Pill.tsx`)
- **Style:** `rounded-full`, 15%-alpha tint background, full-strength text color from the same semantic/type/stage token.
- **State:** `py-0.5` when static (a read-only badge), `py-1` when interactive (a clickable trigger — e.g. the state picker) — the extra 2px brings the tap target to the WCAG 2.2 AA floor without changing the visible pill size. This rule already held with zero exceptions before the token migration; it's now codified in one component instead of repeated per call site.

### Cards / Containers
- **Corner Style:** `rounded-card` (10px).
- **Background:** `surface` for plain rows (PRRow), a type-tinted `surface`-based background for story/task/sprint cards.
- **Shadow Strategy:** none at rest — see Elevation & Depth.
- **Border:** 1px, type-tinted at 30% alpha to match the card's tint.
- **Internal Padding:** `p-4` for story cards, `pl-4 pr-3 py-2.5` for task cards (the extra left padding clears the spine).

### Inputs / Fields (`ui/SearchInput.tsx`)
- **Style:** `rounded-full`, `surface-sunken` background, no border until focus.
- **Focus:** `focus-visible:border-accent` plus the shared `.focus-ring` treatment (`ring-2 ring-accent ring-offset-2`).

### Navigation
- Pill-shaped nav links (`rounded-full`, `text-xs font-medium`); active state is `bg-accent/15 text-accent`, inactive is `text-ink-muted` with a color transition on hover. Icon-only on narrow viewports, icon+label from `sm:` up.
- In-page tabs (`ui/Tabs.tsx` — e.g. the Team page's per-person Work Items/Pull Requests switch) reuse this exact pill idiom rather than inventing an underline or segmented-control look, with `role="tablist"`/arrow-key roving focus layered on top.

### Popover (`ui/Popover.tsx` + `lib/usePopover.ts`)
The one dropdown/menu shape in the system: `rounded-card`, `shadow-lg`, `z-popover`, anchored `right-0` or `left-0` with `mt-1`. Every instance (state picker, sprint-mismatch chip, story bulk-move, View/Type menus, account menu) shares the same open/close/click-outside/Escape plumbing — previously 3 of these hand-rolled their own click-outside effect independently.

### Charts (`ui/BarChart.tsx`, `ui/LineChart.tsx`)
Inline SVG, not a charting dependency (research.md R6 in `the original design notes` — Node 16 rules out anything requiring ≥18, and a library is a large tree for a bar series and a two-line series). Both draw against the `--chart-*` custom properties already defined in `index.css` for both themes — `--chart-series-1`/`--chart-series-2` for data, `--chart-axis` for the baseline, `--chart-grid` for gridlines, `--chart-muted` for a reference line, `--chart-good`/`--chart-critical` reserved for a future threshold-crossing series. These are deliberately **separate from** the accent/status/type token families: a data series isn't a selection, a status, or a work-item type, so it doesn't borrow The Coding Rule's vocabulary — it has its own. `BarChart` renders a per-sprint bar (optionally split into a full-tone "measured/completed" segment and a lighter-opacity "partial" cap on the same bar, rather than a second hue) against an optional dashed reference line (the historical average). Both are `<svg role="img">` with a `<title>` carrying the same values as plain text, so the data is available to assistive tech without a second, hand-maintained summary.

## Do's and Don'ts

### Do:
- **Do** use `Pill` for every status/type badge — never a raw `rounded-full` span with inline color classes.
- **Do** use the `-tint` token at 15% alpha for fills and the base token for text, per The Two-Tier Rule.
- **Do** give every icon-only control a real `aria-label` — `IconButton`'s type enforces this.
- **Do** pick icon sizes from the 12/14/16/20 scale: 12 inline-with-text, 14 default UI, 16 section header/disclosure, 20 feedback/spinner.
- **Do** keep the 4px spine on story/task/sprint cards — it's the system's one earned exception to the thin-border default.

### Don't:
- **Don't** introduce a new hue that doesn't map to a status, work-item type, or workflow stage (The Coding Rule).
- **Don't** add a shadow to an element that isn't a floating overlay (The Flat-By-Default Rule).
- **Don't** hand-roll a click-outside effect — use `usePopover` from `lib/usePopover.ts`.
- **Don't** use `text-[11px]` or any bracket-value font size — `text-xs` (12px) is the floor of the type scale.
- **Don't** remap `StateChip`'s state→tone lookup to the server's `stateCategory` — it stays keyed by state name; that's a logic decision, not a styling one, and out of scope for this system.
