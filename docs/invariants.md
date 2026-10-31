# Key invariants

The incident-backed rules, with their measurements and history. Read the relevant entry before touching that area.


- Work Items page and Dashboard "Recently updated" use different visibility windows on purpose: the
  grouped Work Items view excludes pre-2026 sprints; the Dashboard's recent list is not subject to
  that cutoff (it mirrors ADO's own 30-day "Recently updated" view instead).
- `StateChip`'s state→color mapping is keyed by literal state name, not the server's `stateCategory` —
  intentional, see `DESIGN.md`/the component's own comments.
- A teammate's dashboard (Team page) is never background-polled like your own; it syncs on open, then
  is served from cache and revalidated in the background once >5 minutes stale.
- **A cross-sprint-promoted child never contributes to any group's `hours`.** A task whose own sprint
  differs from its parent story's is rendered TWICE — nested under its story (unchanged, badged by
  `SprintMismatchChip`) and as a standalone entry in `IterationGroup.crossSprintItems`, its OWN
  sprint's bucket, naming its parent via `ParentRef` (`components/ParentSprintRef.tsx`). Both are the
  same work item; only the second is new. `crossSprint.js`'s promotion happens, and
  `groupByIteration`'s `crossSprintItems` array is appended, strictly AFTER each group's `hours` is
  reduced over `stories + unparentedItems` only — the child's hours already live inside its parent
  story's rollup, in the PARENT's own group, so counting them again here would inflate that other
  sprint's total. `crossSprintItems` is always an array (`[]` when empty), and a sprint with a
  promotion but no story/unparented item of its own still gets a group created for it (zero hours).
  Client-side, `WorkItemsView`'s `visibleCount`/`totalCount` count **distinct work item ids** for
  exactly this reason — a promoted entry adds a row, never a second count.
- **A WIQL query rejects a time in a date comparison.** `[System.ChangedDate] > '<full ISO
  timestamp>'` fails with 400 "You cannot supply a time with the date when running a query using date
  precision" — so `wiqlDate()` in `ado/workitems.js` trims it to `YYYY-MM-DD`. This had silently broken
  the incremental/partial sync pass on every project since it was written; `_runSync` catches a failed
  partial pass, so the only symptom was that the fast first paint never happened.
- **A WIQL query is organization-scoped.** The project in the request URL
  (`{org}/{project}/_apis/wit/wiql`) does *not* restrict results — only an explicit
  `[System.TeamProject]` clause does. Measured: the same leaf query returned 356 items in *both*
  projects without the clause, 349 / 0 with it. `teamProjectClause` in `ado/workitems.js` is applied to
  every query there (both link sides on the tree query); any new WIQL anywhere must carry it, or that
  project's dashboard fills with every other project's work.
- **WIQL's `EVER` operator** (`[System.AssignedTo] EVER '<user>'`, `ado/workitems.js#queryEverAssigned`,
  backing `GET /api/workitems/search`) evaluates a field across a work item's WHOLE revision history
  rather than its current value — the only way to answer "was this person ever assigned this item?" in
  one round trip instead of walking `/updates` per candidate. Verified live against this org, one
  identity, ProjectA: 549 ever-assigned (200, not 400), 115 of those not currently assigned with
  zero overlap against the 432 currently-assigned items (proves the `<> uniqueName` exclusion clause
  works), 0 when the same query is pointed at a second project (`ProjectC`) — `everAssignedClause`'s
  own doc comment in `ado/workitems.js` carries the full measurement, the same way
  `teamProjectClause`'s comment above does.
- **Nothing branches on a work item state NAME, or a work item type name.** State names and type names
  are process-template properties (`Closed`/`Done`, `User Story`/`Product Backlog Item`/`Issue`/
  `Requirement`). Both are discovered per project — `ado/workItemTypes.js` from ADO's type *categories*,
  `ado/states.js` per discovered type — and every decision is made on the `category` ADO returns
  (`Proposed|InProgress|Resolved|Completed|Removed`) via `compute/workflow.js`. `ado/writeback.js`
  resolves its auto-close/auto-activate targets that way and refuses a state the current project doesn't
  have, rather than sending an invalid write.
  - Auto-activate keys on the workflow's **initial** state, not "any Proposed state" — this org's `Task`
    workflow puts `OnHold` in the Proposed category, and its `User Story` has four Proposed states.
- **"My work" is every type assigned to me, not only stories/tasks/bugs** (007-all-assigned-types).
  `queryAssignedItems` in `ado/workitems.js` carries **no type clause and no state clause** on purpose:
  `_runSyncPass` drops Removed-*category* items after hydration (never counted as "hidden by state"), then
  places the rest with `classifyByCategory` (`ado/workItemTypes.js`) — a requirement-category item outside
  any tree is a *childless story*, everything else an unparented item. Only `queryAssignedTree`'s Source
  side stays story-typed, because it defines containers. `ensureTypes` also discovers `everyType` (every
  type's states and whether it carries Completed Work, one `GET /wit/workitemtypes` call), so `ensureStates`
  covers every type. An hours write to a type without Completed Work is refused with `TYPE_NO_HOURS`
  before any PATCH (`hoursEditable` on the item is the UI courtesy). The "Tasks in progress" tile keeps its
  label but counts every assigned type. Cache keys bumped to `dashboard-v9`/`types-v2`/`states-v2`. The
  inherited literal `<> 'Removed'` in the tree, Recently-updated and past-ownership queries is a recorded
  exception (`the original design notes`, Complexity Tracking).
- **Cross-project hours attribute by `changedBy`, not by assignee.** The per-project card feeds the
  revision index the ids of the person's own assigned tree and filters deltas by who made the
  revision; `crossHours.js` takes the ids from the index itself (every item with a revision by this
  person), which costs no ADO calls and answers "hours I logged" rather than "hours logged on items
  currently assigned to me". The two agree except for an item later reassigned away — where the
  cross-project view keeps those hours and the per-project card drops them.
- **A person can carry more than one Azure DevOps identity** (006-linked-identity-aliases — this
  deployment's own `legacy-example.onmicrosoft.com` → `EXAMPLE.DEV` migration is the motivating case). On sign-in,
  `server/identitySet.js#resolveIdentitySet` links every identity in the org whose username (the part
  before `@`) matches the signed-in one, exactly, case-insensitively — no configuration, no domain
  list. `person.id` / `person.uniqueName` keep meaning the **primary** (signed-in) identity everywhere;
  the widened set lives at `person.identities` (`{primary, linked, all, ids, keys, degraded}`), lazily
  resolved and 24h-cached per scope alongside `discovery` (never awaited by `POST /api/auth/project`).
  Every READ that is scoped to "a person" widens to the whole set: the WIQL assignee/`EVER` clauses in
  `ado/workitems.js` become a parenthesised OR-group (`assigneeOrClause`/`everAssignedOrClause`) ANDed
  alongside `teamProjectClause`, never loosening it; `fetchPullRequests` in `ado/pullrequests.js` runs
  one search per identity and unions by `pullRequestId` (its empty-result retry stays *inside* each
  per-identity fetch, never raced by `Promise.all`); hours attribution (`compute/timeline.js`'s
  `personKey`, `crossHours.js`, and Scrum utilisation's roster merge in `scrum.js#_mergeLinkedIdentityHours`)
  widens from a single lowercased uniqueName to a `Set` of them. **The write path is deliberately
  untouched**: `ado/writeback.js#assertAssignedTo` compares only against the primary identity's id, so
  an item still assigned to a linked (e.g. retired) identity is read-only — the dashboard payload's
  per-item `editable` flag (computed with `isPrimary`, never `isPerson`) is a UI courtesy reflecting
  that, not the enforcement. The disk cache key bumped to `dashboard-v8`/`pr-index-v3` for this reason
  (a pre-v8 payload built from one identity would repaint a migrated person an incomplete dashboard
  that looks authoritative); the revision index itself was deliberately **not** re-versioned, since it
  is project-wide and person-agnostic and only the per-person read of it widened, so no cold re-walk is
  incurred. See `the original design notes` for the full spec/plan/research, and that
  feature's `research.md` for the two live-verification checks (R1: does IdentityPicker still resolve a
  disabled identity; R2: does Azure DevOps accept the widened OR-group WIQL shape) that were **blocked**
  at implementation time — the only credential available then belonged to the very identity being
  retired, itself live confirmation that the migration is real — and still need running against a
  working post-migration PAT before this is considered fully verified.
- Pull requests are **org-scoped on purpose** — the one deliberate exception, kept because a story
  ships across repositories that don't all live in its own project, so a project-scoped PR list is an
  incomplete and unsearchable answer to "what shipped this story". Read the module comment in
  `ado/pullrequests.js` before changing it. What makes that safe rather than sloppy: attribution
  resolves across projects (`/wit/workitemsbatch` reads any work item the token can see, even through a
  project-scoped URL — verified live), each PR carries its own `projectName`, and `PrRepoList` renders
  that as a Pill whenever it differs from the signed-in project. PR-page story links use the org-level
  work item URL (`workItemUrl(org, null, id)`) because the story's project is genuinely unknown there.
  The attribution candidate cache lives in the shared `.cache/_org/`, since a PR is the same PR
  whichever project you view it from.
- Two PR-fetch defences exist because an ADO response of `{value: []}` is indistinguishable from "this
  person has no PRs": `fetchPullRequests` retries once when the result is completely empty, and
  `_runSyncPass` refuses to overwrite a non-empty PR index with an empty one. Both were added after a
  real incident — under rate-limit throttling a sync cached zero PRs and the page stayed blank
  afterwards.
- `server/scopes.js`'s header comment carries a **full scoping audit** — every ADO data source, whether
  it is project- or org-scoped, and why. Read it before adding a new ADO call.
- Everything a person persists client-side (filters, grouping, sprint pick, the cached dashboard
  payload) is namespaced by project id — see `lib/activeProject.ts`. Adding a new localStorage key
  without that namespace is how project A's state shows up under project B.
- **Internationalization: nothing branches on language preference in logic, only in render.** The `t()`
  function translates strings at render time; application logic (filtering, sorting, state machines)
  is language-agnostic. Work item state *names* like "Closed" or "In Progress" come from Azure DevOps
  and are not translated — only their UI labels are, via the `StateChip` component. ADO-sourced values
  (person names, project names, branch names, state names) are wrapped in `<Foreign>` to mark them as
  untranslated and avoid double-translation. The language preference is read from `useLanguageStore()`
  at render time and changes trigger a re-render, not a data refetch. Error messages with field labels
  (e.g. "Team has {memberCount} members") interpolate the `details` object from the server response,
  which provides the count; the field label itself comes from the catalog via `t()` in the error handler.
