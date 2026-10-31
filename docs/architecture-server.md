# Server architecture

Per-module notes for `server/`. Read the module note here before changing that module.

### Server (`server/`, CommonJS)

`server/index.js` is a Fastify app exposing `/api/*` routes; in production it also serves `web/dist`
via `@fastify/static` with an SPA fallback (`setNotFoundHandler` → `index.html` for non-`/api` 404s).

- **`server/ado/`** — all Azure DevOps REST API access lives here (`client.js` is the low-level HTTP
  client; the PAT is sent as a Basic-auth header and never leaves this layer). Notable files:
  `workitems.js` (WIQL queries — see the `[System.TeamProject]` entry in `docs/invariants.md`), `writeback.js` (write
  endpoints + optimistic concurrency via `rev`), `workItemTypes.js` (which types this project's process
  template uses, from ADO's type *categories*) and `states.js` (each of those types' real workflow
  states, with their categories), `revisionIndex.js` (the full work-item revision history index that
  powers hours-per-day — expensive to build, so it's cached), `wiki.js` (reads/writes the Dashboard Roles
  page), `pullrequests.js` (per-project PR search + `filterToProject`), `prAttribution.js` (links PRs to
  work items).
- **`server/compute/`** — pure functions that turn raw ADO data into what the client renders:
  `rollup.js` (story/task hour rollups, visible-state filtering), `timeline.js` (hours-logged
  timeline), `iterationGrouping.js` (sprint grouping), `crossSprint.js` (the cross-sprint child
  **promotion** predicate — see the key-invariants entry below), `prGroups.js` (PR→repo→story
  grouping), `workflow.js` (one type's real state list → its initial/in-progress/completed/done
  states, by ADO category — the reason no state name is hardcoded anywhere).
- **`GET /api/workitems/search`** (`server/ado/workitems.js#queryEverAssigned` +
  `SyncEngine#searchEverAssigned`) — "search reaches past ownership": items in the session's project
  that the target person was EVER assigned (WIQL's `EVER` operator against `[System.AssignedTo]`) and
  is NOT assigned now, matching a text query. Read-only, adds no write path — a past-owned result is
  rendered with `isSelf={false}` (courtesy only; `assertAssignedTo` in `ado/writeback.js` is the real
  enforcement, and refuses a write to it by construction). Results are cached per scope in a small
  in-memory LRU (32 entries, 60s TTL) — never `.cache/`, since a transient search result doesn't
  belong in a directory whose contract is "disposable, deletable, rebuilds correctly". Every
  `workitemsbatch` hydration is re-checked for `System.TeamProject` before it reaches a `Task`, same
  as `ado/sprintItems.js`. `EVER` is verified live against this org (549 ever-assigned, 115
  past-not-current, 0 leaking into a second project — see `everAssignedClause`'s doc comment for the
  full measurement).
- **`server/crossHours.js`** — the one engine that spans projects instead of living inside one: the
  one person's hours summed over every project the CALLER's token can read (`GET /api/hours/cross`,
  the "All projects" tab on the Dashboard hours card and on each Team member's). It walks the scope
  registry, and per project reads that scope's own revision index for the items carrying a revision by
  this person — so no WIQL, and a project is only ever read through its own scope. Every breakdown row
  carries its project, and the result is cached per **viewer+person** in `.cache/_org/`. Runs as a
  polled JOB, not a request: a first build over projects that have never been opened pays each one's
  cold index walk (~1-2 min each), and builds are queued so two open cards never walk at once.
  `?person=` (Team page, gated on `canSeeTeamPage`) changes only WHOSE `changedBy` is counted — the
  scopes are still opened with the caller's PAT and identity, so it can never read a project the
  caller couldn't open themselves, and a teammate's project the caller can't read is simply absent
  from the total (the card says so).
- **`server/sync.js`** — the `SyncEngine`: orchestrates ADO fetches + compute steps into a per-person
  dashboard payload, owns caching/staleness/background revalidation, and drives the SSE push
  (`onUpdate`) that tells open tabs to refetch. This is the file to read first to understand how data
  flows end to end. **One instance per project**, not per process.
- **`server/scopes.js`** — the project registry, and the thing to understand before touching any
  route. `getScope({id, name})` lazily builds `{ config, cache, sync, readToken }` for one project:
  its own `AdoClient`, `SyncEngine`, `Cache` **directory** (`.cache/<slug>-<id8>/`, so no cache key
  needed a project prefix) and org chart. The `onRequest` hook in `index.js` resolves the session's
  project into `req.session.scope`, and every handler starts with `const { sync } = req.session.scope`
  — a route that reads a process-global engine is a bug. Also owns: read-token election (service
  `ADO_PAT` where it can read the project, else the opener's own PAT — never persisted, never used for
  background polling), the single sequential poll timer across resident projects, LRU/idle eviction,
  and the one-time migration of pre-multi-project `.cache/*.json` into the default project's dir.
- **`server/cache.js`** — disk cache under `.cache/<project-slug>/`; deleting a project's directory
  forces a full clean resync of it (the revision-index rebuild is the slow part, ~1-2 min).
  `.cache/_org/` holds the org-wide PR attribution cache, shared across projects because PRs are.
- **`server/org.js` / `server/orgStore.js`** — the org chart (teams, members, roles, reporting lines)
  behind the Team page and its "Manage team" admin UI. `org.js` is the pure data shape/logic (role
  capabilities, the assignable-roles matrix, tree traversal, markdown render/parse); `orgStore.js` is
  the persistence layer. The durable copy lives on the **Dashboard Roles page of that project's own
  `<project>.wiki`** (a fenced JSON block) rather than a local file — which is both what makes teams
  per-project (no `projectId` field exists in the schema; the storage location *is* the scoping) and
  what lets the chart survive hosts with no persistent disk (e.g. Render's free tier). Every write
  updates the wiki page (guarded by its ETag, so a concurrent edit surfaces as a 409 instead of being
  silently clobbered); `data/org/<slug>.json` is a best-effort fallback cache only. Requires the PAT to
  have **Wiki Read & Write** (not just Read). A project with **no wiki at all** degrades on purpose:
  reads yield an empty chart (Team page hidden for non-owners) and the first save fails with a
  `WIKI_MISSING` ValidationError plus `wikiAvailable: false` on `/api/org` and `/api/team`, which the
  UI explains. The app deliberately never creates a wiki.

- **`server/scrum.js` / `server/scrumConstants.js` / `server/blockedConvention.js`** — the Scrum page
  (leads/principals/scrum accounts, gated on the same `canSeeTeamPage` rule as Team): six read-only
  views over one sprint or a window of sprints — velocity, per-story progress, per-person utilisation,
  burndown, blocked/stalled impediments, and scope change. Two data sources feed all six: the revision
  index (`server/ado/revisionIndex.js`), bumped to **v3** to carry `remainingWork`, `state`,
  `iterationPath`, `estimate`, and `workItemType` history (a v2 entry has no `remainingWork` key at all,
  which is why the version bump forces a full re-walk rather than tolerating old entries as-is); and
  `server/ado/sprintItems.js`, a project-scoped batch read (`POST /wit/workitemsbatch`) of the sprint's
  current title/assignee/tags/blocked-field/URL, whose ids come from the index's own `iterationPath`
  history (so no new WIQL is introduced). **That batch read's `System.TeamProject` filter is mandatory,
  not defensive**: `/wit/workitemsbatch` returns any item the token can see even through a
  project-scoped URL — the same property that makes cross-project PR attribution work on purpose is a
  cross-project leak hazard here, so every returned item is re-checked before it reaches a compute
  module. Velocity's re-estimate handling is the feature's most misreadable rule, worth stating plainly:
  **FR-008c wins outright — a closed sprint's already-credited share is never revised for any reason,
  including a later re-estimate; conservation is enforced prospectively at the completing sprint
  instead, and a downward re-estimate that falls below what's already credited discloses the shortfall
  (`overDistributedBy`) rather than clawing anything back.** The blocked convention (states/tags/field
  per work item type that mean "blocked") is this feature's one deliberately *configured* judgement
  rather than a discovered one — Azure DevOps has no Blocked *category* — and is persisted alongside the
  org chart on the same wiki page/ETag (`server/orgStore.js`'s `blockedConvention` field), editable only
  by the dashboard owner (project-wide), never a subtree-scoped team lead. Utilisation's capacity read
  has a no-fallback rule worth remembering before touching it: `server/ado/capacity.js` reports a
  person's `hours` exactly as ADO's own per-activity `capacityPerDay` records it and performs **no**
  working-day, sprint-length, or standard-workday arithmetic on top — inventing a number from a proxy is
  exactly the failure mode the spec forbids.
