# Client architecture

Per-folder notes for `web/src/`, including the full internationalization (i18n) rules.

### Client (`web/src/`, React + TypeScript + Vite + Tailwind)

- **`app/Layout.tsx`** — the shell: sticky header, nav, theme toggle, account menu.
- **`features/*/`** — one folder per route (`dashboard`, `workitems`, `pullrequests`, `team`, `scrum`),
  each a thin page component that calls `useDashboard`/`useTeam`/`useScrum` and renders shared
  components. `features/scrum/ScrumPage.tsx` owns the one shared sprint selector every card below it
  binds to (`VelocityCard`, `SprintProgressCard`, `UtilisationCard`, `BurndownCard`,
  `ImpedimentsCard` + `BlockedConventionEditor`, `ScopeChangeCard`) — two cards can never describe two
  different sprints, and each is its own React Query entry so one card's failure can't blank another.
- **`components/`** — page-level building blocks (`StoryCard`, `TaskCard`, `PRRow`, `StateChip`,
  `IterationGroupSection`, `WorkItemsView` — the last is the filtering/search/grouping engine shared
  by both the Work Items page and each Team member's embedded section).
- **`components/ui/`** — the shared design-system primitives (`Toolbar`, `SearchInput`, `IconButton`,
  `AccentBar`, `Pill`, `PrimaryButton`, `InlineMessage`, `Popover`) — see `DESIGN.md` for the token
  system and rules these implement. Prefer extending/reusing these over inlining new variants of the
  same pattern.
- **`lib/`** — data layer and cross-cutting logic: `api.ts` (fetch wrapper), `useDashboard.ts`/
  `useTeam.ts`/`useMe.ts` (React Query hooks), `typeTheme.ts` (work-item-type → color token mapping),
  `workItemViews.ts` (the drill-down predicates shared between Dashboard stat tiles and the Work Items
  page filters — a tile's count and its filtered list must always agree, so both read the same
  predicate), `sprintMismatch.ts`, `currentSprint.ts`, `persistedState.ts` (localStorage-backed state
  hooks), `usePopover.ts` (shared open/close/click-outside/Escape plumbing for every dropdown),
  `activeProject.ts` (the project id every localStorage key is namespaced by — set synchronously by
  `RequireAuth` before children render, because those consumers read localStorage during their own
  initial render; anything newly persisted must go through it or it leaks across projects).
- **`features/auth/`** — `LoginPage.tsx` (the three-step gate: password → PAT → project, native radios
  for the project list), `RequireAuth.tsx` (anything but `stage: 'ready'` bounces to `/login`).
- **Data flow**: React Query hooks poll `/api/dashboard`; the server also pushes SSE
  (`dashboard-updated`) events over `/api/stream` that trigger a refetch instead of the client polling
  blindly — see `useDashboard.ts` for how the two combine.
- **Design system**: `DESIGN.md` (+ `.impeccable/design.json` sidecar) documents the token system —
  semantic status tokens, work-item-type tokens, workflow-stage tokens, the icon-size scale (12/14/16/
  20), and the named rules (The Coding Rule, The Spine Rule, etc.). Read it before adding new colors,
  icon sizes, or component variants.
- **Internationalization (i18n)**: full English/Arabic bilingual support with RTL layout and Tailwind
  logical utilities. `web/src/lib/i18n/` holds `en.ts` and `ar.ts` — flat-keyed translation catalogs
  (`ar.ts` typed against `keyof typeof en`, so a missing Arabic key fails `tsc -b` rather than falling
  through silently at runtime) with CLDR plural support (2 categories for English, 6 for Arabic);
  `glossary.ts`, the concept → term table for the 23 contested vocabulary decisions (`translate` /
  `transliterate` / `keep-english`) that keep both catalogs using one term per concept; and
  `useLang.ts`, the Zustand store (`useLang()`, NOT `useLanguageStore` — that name doesn't exist)
  holding `{ lang, dir, setLang }`. Import `useTranslation()` from `'../../lib/i18n'` inside a
  component (it subscribes to `lang` so the component re-renders on switch) and use
  `t('nav.dashboard')` for simple strings or `t('workitems.count', { count: n })` for plurals; the
  same module also exports a plain, non-hook `t()` for the rare call site outside a component body
  (e.g. a module-level id→label lookup) — that one does NOT trigger a re-render on switch, so it must
  only be called during a render that something else already re-triggers (see `roleLabel()` in
  `features/team/manage/roleRules.ts`, called from components that already subscribe via
  `useTranslation()`, and the `voteLabel()`/status-pill pattern in `components/PRRow.tsx`).
  **Every value ADO or the wiki actually returned — person names, work item states and types, tags,
  iteration paths, project/repository/branch names, PR titles — is rendered verbatim in both
  languages, never translated or looked up by name**; wrap it in the `<Foreign>` primitive
  (`components/ui/Foreign.tsx`) to mark it as intentionally untranslated. Two more `components/ui/`
  primitives round out the feature: `LanguageToggle.tsx` (the header/sign-in switch, `components/ui/
  LanguageToggle.tsx`) and `DirectionalIcon.tsx` (wraps a directional icon — chevrons, back/paging
  arrows — and flips it under RTL so new usages can't forget to). RTL layout uses Tailwind logical
  utilities (`ms-`, `me-`, `ps-`, `pe-`, `text-start`, `border-s-`, `rounded-s-`) instead of
  direction-specific ones (`ml-`, `mr-`, `pl-`, `pr-`). A pre-paint script in `web/index.html` applies
  the saved language/theme (and sets `<html lang/dir>`) before first paint so a reload never flashes
  the wrong direction. Error responses from the server include a `details` object (e.g.
  `{ memberCount: 5 }`) — the *client* renders the actual sentence in the active language from a
  `code` (e.g. `TEAM_NOT_EMPTY`) plus that object; the server only ever gains a `code` and `details`
  on top of its existing English `error` string, never a translated string of its own — see
  `codedValidationError` in `server/orgStore.js` for the server side and `readAndClearLoginReason` in
  `web/src/lib/api.ts` for the equivalent one-shot pattern on login-redirect reasons
  (`PAT_EXPIRED`/`PROJECT_UNAVAILABLE`).
