# Full operations guide

A personal Azure DevOps dashboard. It shows **your own** work items, hours and pull requests in one
place, and — for leads and principals — a **Team** page for following teammates' work.

You sign in with a shared team password, then your own Personal Access Token, then pick which of
**your** Azure DevOps projects to work in. Everything after that — work items, hours, pull requests,
teams — comes from the project you picked, and your writes land in Azure DevOps under your own name
because they run under your own token. Switching project is a row in the account menu.

It runs the same way on `127.0.0.1` as it does on a hosted deployment: there is one login flow, not
a local shortcut and a "real" one.

---

## Requirements

- **Node.js 16.x** — this is a hard pin (`"engines": ">=16.0.0 <17.0.0"` in
  [package.json](../package.json)), not a suggestion. A different major version may fail to install or
  run.
- npm (ships with Node).
- An Azure DevOps account with access to the project you want to point this at.

---

## First run, after cloning

Run these in order, from the repo root:

```bash
git clone <this-repo-url>
cd azure-dashboard

npm install              # server dependencies
npm install --prefix web # client dependencies — a SEPARATE install, easy to miss

cp .env.example .env
```

Now open `.env` and fill in two required values:

- `ADO_ORG` — your Azure DevOps organization.
- `APP_PASSWORD` — the shared password that gates sign-in. Any long, random phrase.

Everything else is optional. `SESSION_SECRET` is generated for you on first start and saved to
`data/session-secret` so your session survives a restart. `ADO_PROJECT`, if set, is just the project
preselected on the sign-in project step. `ADO_PAT` is only the shared "service" token for background
polling — see [**The ADO_PAT**](#the-ado_pat) below for the scopes and why it's optional.

Then:

```bash
npm start
```

Open **http://127.0.0.1:5174** and sign in:

1. **Team password** — the `APP_PASSWORD` you just set.
2. **Your access token** — your own PAT ([scopes here](#the-ado_pat)).
3. **Project** — pick from the projects that token can actually read.

**The very first sync of a project takes 1–2 minutes.** It has to build a full index of that
project's work item revision history to compute hours-per-day correctly — once per project. It's
saved under `.cache/<project>/`, so every sync after that (and every future restart) is fast, and
opening a second project pays the same cost once for that project. The Dashboard page will show
a "syncing" state until that first pass finishes; no action needed, just wait.

---

## Stopping and restarting

Stop it with `Ctrl+C` in the terminal it's running in. To bring it back up later:

```bash
npm start
```

That's it — restarts are fast, because `.cache/` survived the stop and nothing needs re-fetching
from scratch.

**If the port is already taken** (usually an old server process that didn't exit cleanly), on
Windows:

```powershell
netstat -ano | findstr :5174
taskkill /PID <the-pid-from-above> /F
```

(swap `:5174` for whatever `PORT` you've set, if you changed it from the default).

---

## Running as a service (IIS)

> **Status: retired on this machine.** Now that the team deployment on Render (see
> [Deploying for a team](#deploying-for-a-team)) is the shared instance everyone uses, the local IIS
> service has been stopped and disabled (`Stop-Service azure-dashboard` /
> `Set-Service azure-dashboard -StartupType Disabled`) rather than removed — it's a clean rollback
> path if Render is ever unavailable. The section below is left as-is for that scenario, and
> `deploy/` is kept in the repo for the same reason.

Instead of a terminal you have to keep open, the app can run as a background Windows service,
fronted by a local IIS site at a friendly hostname instead of a raw port. This is what used to be set
up on this machine:

- **URL**: `http://azure-dashboard.local` (no port needed) — an entry in
  `C:\Windows\System32\drivers\etc\hosts` maps that hostname to `127.0.0.1`/`::1`. On a fresh machine,
  re-add it:
  ```
  127.0.0.1  azure-dashboard.local
  ::1        azure-dashboard.local
  ```
- **Layout**: IIS site `AzureDashboard` (bound only to the loopback interface, `127.0.0.1`/`[::1]`, on
  port 80 with that host header) reverse-proxies every request to the Node server, which runs as a
  Windows service named `azure-dashboard` on `127.0.0.1:5174` — the same server, unchanged, just
  started by Windows instead of by hand. IIS itself serves no files; `deploy/web.config` is a
  proxy-only rule.
- **Service management**: `Get-Service azure-dashboard`, `Restart-Service azure-dashboard`,
  `.logs/azure-dashboard.out.log` / `.err.log` for output. The service definition is
  `deploy/azure-dashboard.xml`, run via the [WinSW](https://github.com/winsw/winsw) wrapper at
  `deploy/azure-dashboard.exe` (not committed — download the latest `WinSW-x64.exe` release and
  rename it if setting this up on another machine).
- **Deploying a change**: run `deploy/update.ps1` — pulls, reinstalls both dependency trees, rebuilds
  the frontend, and restarts the service. A frontend-only change doesn't strictly need the restart
  (`@fastify/static` reads `web/dist` off disk on every request), but the script does it anyway for
  simplicity.
- Still localhost-only: the IIS binding, like the Node server itself, only listens on the loopback
  interface, so the same [Security notes](#security-notes) apply unchanged.

---

## Deploying for a team

Everything above assumes one person on `127.0.0.1`. To let teammates use the same deployment, each
with their own Azure DevOps identity, two things change: the server needs to be reachable beyond
your machine, and it needs a login gate in front of it — the loopback bind that provides all of the
security in [Security notes](#security-notes) doesn't help once the server is listening on a public
interface.

### The login gate

The same gate every deployment has (see [First run](#first-run-after-cloning)), so nothing extra to
turn on. Signing in is three steps:

1. **Team password** — the shared `APP_PASSWORD`, the same for everyone.
2. **Your access token** — each person enters their *own* PAT (scopes: [The ADO_PAT](#the-ado_pat)).
   The server verifies it resolves to a real identity in `ADO_ORG` and asks Azure DevOps which
   projects it can see.
3. **Project** — the person picks one of those projects. The server double-checks the token can
   actually read work items there (being *listed* only needs Project and Team (Read)), then binds it
   to their session.

That person's writes (logging hours, changing state, moving sprints) happen under *their own* PAT —
they show up in Azure DevOps as made by them, not by whoever's `ADO_PAT` is in `.env`. `ADO_PAT` is
only the "service" token for shared, project-wide reads (the sprint list, the people directory, the
revision index that powers hours-per-day) and for background polling. For a project it can't read,
those shared reads fall back to the token of whoever opened that project, and background polling is
skipped there — so a teammate's own project works without the deployment's token being granted
access to it.

Two people can be in two different projects at the same time; each request is served from the
project on that person's session. To switch, open the account menu (the avatar, top right) and use
**Switch project** — it re-binds the session to the project you pick and reloads, without asking for
the password or the token again. "Which project am I looking at?" is still answered by the session
and the pill in the header, never by a stale menu selection: the switch is a full page load, so the
header, the cached payloads and everything persisted per project flip at the same instant.

`SESSION_SECRET` is worth setting explicitly on a hosted deployment: unset, it's generated and
written to `data/session-secret`, which a host with no persistent disk throws away on every deploy
(signing everyone out).

Sessions are a self-contained encrypted cookie (AES-256-GCM), not a server-side session store —
there's nothing to clean up, but there's also no way to revoke one person's session individually.
Rotating `SESSION_SECRET` signs *everyone* out at once; that's the only "kick everyone off" lever.

### Running it somewhere reachable

The included `Dockerfile` builds the frontend at image-build time (not at container start — see
`package.json`'s `start` script for why that matters on a small instance) and runs
`node server/index.js` in production mode. `HOST=0.0.0.0` is required in the container so the
platform's proxy can actually reach it (the default, `127.0.0.1`, is unreachable from outside a
container — that's the whole point of the loopback bind locally, but it has to change here).

A free option that needs no domain and no payment method: [Render](https://render.com)'s free web
service plan reads `render.yaml` in this repo, builds the `Dockerfile`, and gives you an
`https://<name>.onrender.com` URL with HTTPS included. Set `ADO_ORG`, `ADO_PROJECT`, `ADO_PAT`,
`APP_PASSWORD`, and `SESSION_SECRET` as environment variables in the Render dashboard (`render.yaml`
marks them `sync: false` — secrets, not committed). The free plan sleeps after 15 minutes idle; a
free uptime pinger (e.g. [cron-job.org](https://cron-job.org)) hitting `/api/health` every 10 minutes
keeps it warm, since a cold start both takes ~50s to boot and — on a plan with no persistent disk —
re-pages the whole project's revision history (~78s the first time; see
[How it stays up to date](#how-it-stays-up-to-date)).

### For teammates

What to tell someone you're inviting to use the deployment:

1. The URL (e.g. `https://<name>.onrender.com`) and the shared team password — send the password
   through a different channel than the URL (a DM, not a public channel), since it's the same for
   everyone.
2. They'll need their own PAT with the scopes listed in [The ADO_PAT](#the-ado_pat) — the sign-in
   screen's second step links straight to the right token-creation page and lists the scopes again.
3. The very first load can take a minute or two if the server had gone to sleep (see
   [Running it somewhere reachable](#running-it-somewhere-reachable) above) — that's expected, not
   broken.
4. Their writes (logging hours, changing state, moving sprints) show up in Azure DevOps under *their
   own* name, not the deployment owner's.

### Rotating a token

- **A teammate's own PAT expires or is revoked**: the very next write they make (log hours, change
  state) fails with a clear "your access token has expired" message, and they're signed straight back
  to the login screen with that reason shown — no separate warning happens beforehand, since a PAT
  can't be asked when it expires without a much broader token-administration scope this app
  deliberately doesn't request. See [Token expiry](#token-expiry) below for the full reasoning.
- **The shared service `ADO_PAT` expires or is revoked**: everyone signed in sees a banner ("Shared
  data isn't updating…") until it's replaced — reads (sprints, roster, hours history) stall, but
  everyone's own writes keep working, since those run under each person's own PAT, not the service
  one. Fix: create a new token the same way as [Creating one](#creating-one), then update `ADO_PAT` in
  Render's environment variables (Dashboard → the service → Environment) and let it redeploy.
- **`APP_PASSWORD` or `SESSION_SECRET`**: same place, Render's Environment tab. Changing
  `SESSION_SECRET` signs everyone out immediately — see [The login gate](#the-login-gate) above.

---

## The ADO_PAT

This is the one setting that actually matters, so it gets its own section.

### What it is and why the app needs it

A **Personal Access Token (PAT)** is a credential Azure DevOps issues you in place of your password,
scoped to specific permissions. This app has no user accounts of its own — **your token is your
identity**. You paste it at sign-in, the server asks Azure DevOps "who does this token belong to"
(via `_apis/connectionData`) and which projects it can read, and that's whose dashboard you see.
Every page — Dashboard, Work Items, Pull Requests — shows your own work, and every "log hours" /
"change state" action writes back to Azure DevOps as you.

The optional `ADO_PAT` in `.env` is a different thing: a shared token used only for background
polling and project-wide reads (see [The login gate](#the-login-gate)). It needs the same scopes.

### Creating one

1. Go to `https://dev.azure.com/{your-org}/_usersSettings/tokens`.
2. **New Token**, give it a name and an expiry you're comfortable with.
3. Grant these scopes — all of them, or the app will fail in specific, confusing ways (see below):

   | Scope | Access | Why |
   |---|---|---|
   | **Work Items** | Read & Write | Read is for showing your stories/tasks/bugs. **Write** is what lets the "Log hours" / "Set %" panel actually save — it writes `CompletedWork`/`RemainingWork` back to the task. |
   | **Code** | Read | For attributing pull requests to their work items on the Pull Requests page. |
   | **Project and Team** | Read | For resolving people (assignees, teammates) to names. |
   | **Wiki** | Read & Write | For the Team page's roster and its "Manage team" admin UI — see [Team roles and membership](#team-roles-and-membership-for-leads-and-principals) below. **Write** is what lets Manage Team durably save (to the wiki page, not just a local file that can vanish on hosts with no persistent disk, e.g. Render's free tier) — Read-only means every edit is lost on the next restart. |

4. Copy the token — Azure DevOps only shows it once — and paste it into `.env` as `ADO_PAT=`.

**If you picked Read-only for Work Items**, the app still loads and looks fine, right up until you
try to log hours or change a state — that fails with a **403** and a message pointing at PAT scopes.
That's the tell if this ever happens after the fact, too: a token can be re-scoped down, or expire,
without anyone touching this app's config.

### Token expiry

Tokens expire, and the app can't warn you in advance: asking Azure DevOps "when does this token
expire" needs the **Token Administration** scope, which is an organization-admin-level permission —
adding it just for a countdown would be a much bigger privilege grant than this app should ever hold.
So expiry is handled reactively, not predicted.

**Single-user / local (`.env`'s `ADO_PAT`, no multi-user auth):** the dashboard keeps *starting* fine
— the failure only shows up when it tries to talk to Azure DevOps, as a **401 error** surfaced on the
page (and in the server log: `Azure DevOps rejected the request (401)...`). Fix: create a new token
the same way and swap it into `.env`, then restart (`Ctrl+C`, `npm start`).

**Multi-user deployments** (see [Deploying for a team](#deploying-for-a-team)) split this in two,
since reads and writes run under different tokens:

- **Your own PAT** (entered at sign-in) is only used for *your* writes. When it expires, the next
  write you make fails, your session is cleared, and you're sent back to the login screen with the
  reason shown — see [Rotating a token](#rotating-a-token).
- **The shared service `ADO_PAT`** powers everyone's *reads*. When it expires, everyone signed in
  sees a banner instead of a silent failure — same section.

### Where it lives, and where it doesn't

- Read once at startup from `.env` ([server/config.js](../server/config.js)).
- Sent to Azure DevOps as a Basic-auth header on every API call
  ([server/ado/client.js](../server/ado/client.js)) — that's the *only* place it travels.
- **Never** sent to the browser, and never logged.

### Keeping it private

`.env` is listed in [`.gitignore`](../.gitignore) and has been since the very first commit — it is never
tracked by git. The file that *is* tracked is [`.env.example`](../.env.example), a template with
`ADO_PAT=` left **empty**. That split is deliberate: it means

- your real token never shows up in `git status`, `git diff`, or a commit, no matter how many times
  you edit `.env`;
- anyone who clones this repo gets a harmless template, fills in their *own* token locally, and their
  token is equally invisible to git.

Two rules that keep it that way:
- **Never** run `git add -f .env` (the `-f` is the only thing that could force an ignored file in).
- **Never** put a real token into `.env.example` — that file is meant to be committed.

If a token was ever pasted somewhere outside `.env` — a chat message, a screenshot, a ticket — that's
the real leak path to worry about (git isn't). Rotate it: revoke the old one in Azure DevOps and
issue a new one.

---

## A tour of the app, page by page

### Dashboard (`/`)

The landing page. From top to bottom:

- **Five stat tiles** — active stories, completed stories, tasks in progress, blocked tasks, open
  pull requests. All scoped to you (or whoever's dashboard you're viewing). "Done" is defined by
  Azure DevOps's own per-type `category` (Resolved/Completed), not a hardcoded state-name list —
  the same category a state belongs to on the Work Items page's filters. "Blocked" is a real
  boolean alongside each item's true state, not a synthetic state value. The four work-item tiles
  are links: clicking one opens the Work Items page (or, on the Team page, filters that teammate's
  embedded list in place) with the exact same filter applied, so the tile's number and the filtered
  list's count can never drift apart — they're computed by the same predicates
  (`web/src/lib/workItemViews.ts`). "Tasks in progress" deliberately overlaps "Blocked tasks" (a
  blocked task is still in-progress work); the tile's tooltip notes this.
- **Hours logged** — Today / Yesterday / This week as big numbers, plus a 7-day bar chart underneath.
  Click any figure or bar for that day's breakdown: which work items the hours went to, and how many
  each.

  Two tabs sit on this card: **This project** and **All projects**. The second one — *Cross-project
  hours* — is the same figures and the same day-by-day chart, but summed over **every** project your
  token can read, so a day you split between two projects reads as one total instead of two partial
  ones. Every row in a day's breakdown is then labelled with the project that work item lives in, and
  links into that project rather than the one you happen to be signed in to — which is where "where
  did these hours come from?" gets answered, so the chart itself stays a chart.

  The first time you open it, every project has to be read once, which takes a minute or two per
  project that has never been opened in this dashboard before; the card says so while it works, and
  shows this project's own figures meanwhile. After that it's seconds, and the result is reused for
  10 minutes before being refreshed behind the numbers already on screen. This tab is only on **your
  own** dashboard — the Team page shows a teammate's hours for the project you're both in.
- **Recently updated work items** — this list is built to match Azure DevOps's own *Recently
  updated* work item view, scoped to you: everything assigned to you that changed in the last 30
  days, with closed/removed items filtered out. Two controls sit above it:
  - **State chips** — filter to one or more states; the count next to each updates live.
  - **Type dropdown** — filter to User Story / Task / Bug.

  Ordering isn't just "newest first": a story is shown immediately followed by its own recently-
  updated tasks, so related work reads together. Anything with no visible relationship on screen (no
  parent, no children in the list) sinks to the bottom, newest first.

### Work Items (`/work-items`)

Everything currently assigned to you, from 2026 sprints onward, grouped into collapsible sprint
sections (latest sprint open by default). Controls:

- **Search** — by work item id or title text; matching a task inside a story auto-expands that story
  so the match is visible.
- **State chips** — same filtering pattern as the Dashboard.
- **View menu** (top right):
  - *Group by iteration* — toggle the sprint grouping off for one flat list.
  - *Cumulative progress* — turns on a selection mode; tick any items and a floating bar shows their
    combined hours and completion percentage.
- **Editing a work item's state** — click the state chip on any card to change it directly.
- **Logging hours** — the pencil icon on a task opens a small panel with two modes: *Log hours* (add
  a number of completed hours) and *Set %* (drag to a target completion percentage — the app works
  out the hours for you). Both write back to Azure DevOps immediately.

### Pull Requests (`/pull-requests`)

Every PR you opened anywhere in the organization, grouped by repository and then by the story it's
attributed to. This page is deliberately org-wide even though the rest of the dashboard is scoped to
the project you signed in to: a story is delivered across whatever repositories the change touches, and
those don't all live in the story's own project — so narrowing this would hide PRs and make the search
box unable to find them. A repository belonging to a different project is labelled with that project's
name. PRs the app couldn't confidently link to a story land in a "Not linked to a story"
bucket at the bottom of their repo group, rather than being silently dropped. Search and a status filter (Active /
Completed / Abandoned / Draft) work the same way as elsewhere.

### Team (`/team`)

Only visible in the nav, and only reachable, if the Dashboard Roles wiki page lists you as a `lead`
or `principal` — see the next section. Everyone else gets redirected home; every API route enforces
this independently server-side, so hiding the nav link is a courtesy, not the actual gate.

- **Show members** — a multi-select dropdown of whoever the wiki page lists under your name. Pick one
  or more to open their section below.
- Each selected teammate gets their **own read-only mini-dashboard**: the same stat tiles, hours
  strip, and full work items list as your own Dashboard/Work Items pages — but with no edit controls.
  That's not a UI choice you can override: the server independently rejects any write to a work item
  that isn't actually assigned to you, regardless of what the client sends.
- Picking more than 3 people at once shows a warning — each one syncs independently the first time
  their section opens, so a big batch can take a moment.

---

## Team roles and membership, for leads and principals

The org chart (who's a lead/principal/scrum, who reports to whom, and which teams exist)
**is not stored in this repository**. Its durable copy lives on a page in the Azure DevOps project
wiki, specifically so that having access to the source code doesn't let anyone grant themselves a
role — only someone with edit access to that wiki page can — and so the chart survives on hosts with
no persistent disk (e.g. Render's free tier), where a local file alone would be wiped on every
redeploy or restart.

- **Where**: the wiki page named `Dashboard Roles` (path `/Dashboard Roles`) in **each project's own**
  wiki, `<project>.wiki`. That's what makes teams per-project: the chart you see and edit belongs to
  the project you signed in to, and another project has its own. The page path is configurable via
  `ADO_ROLES_WIKI_PAGE`; the wiki name always follows the project.
- **A project with no wiki** has no org chart and can't get one from here: the Team page stays hidden
  for everyone but the owner, and Manage Team says so instead of failing on save. Create a project
  wiki in Azure DevOps (Overview → Wiki) first — the app deliberately won't create one for you.
- **Normal editing**: use the Team page's **"Manage team"** screen (visible to the dashboard owner, or
  anyone the chart already lists as `lead`/`principal`/`scrum`). Every add/edit/delete there writes
  straight back to the wiki page — you don't need to touch the wiki directly for day-to-day changes.
- **Format**, if you ever want to hand-edit the page directly (e.g. to seed the very first person):
  a fenced ```` ```json ```` code block (any prose around it is fine and ignored). Shape:

  ```json
  {
    "teams": [
      { "name": "Portal Team", "managerMemberId": null }
    ],
    "members": [
      { "email": "lead@example.com", "displayName": "Lead Name", "role": "lead", "parentId": null },
      { "email": "dev1@example.com", "role": "developer", "parentId": "<the lead's id, once assigned>" }
    ]
  }
  ```

  `id` may be omitted on any entry — the app fills one in and writes it back on its next save, so you
  don't have to invent ids by hand. `role` must be one of `developer` / `lead` / `principal` / `scrum`
  (anything else is skipped). `parentId` is who this person reports to (their own generated id, once
  you know it) — this is what builds the reporting tree the Team page reads; `null` means a root.
  Avoid hand-editing while someone is actively using Manage Team: whichever save lands last wins.

- **Failure modes, and what actually happens**:
  - An entry with an invalid/missing `role`, or a `parentId`/`managerMemberId` pointing at nothing, is
    dropped or nulled out — the rest of the chart still loads.
  - If the whole JSON block is broken (a stray comma, a missing brace) or the page/wiki doesn't exist
    yet, the chart simply starts **empty** rather than failing — the owner can then build it via
    Manage Team.
  - A wiki write conflict (someone else saved between your read and your write) surfaces as a clear
    error in the Manage Team UI — reopen it and retry.

- **How fast changes take effect**: immediately — every write re-reads the caller's role from what it
  just saved, so there's no cache lag on your own edits.

---

## How it stays up to date

- A background sync runs for your own dashboard every 3 minutes by default
  (`SYNC_INTERVAL_MS` in `.env`, in milliseconds).
- The browser gets pushed a "data changed" event over Server-Sent Events the moment a sync finishes,
  so open tabs refresh without polling.
- A teammate's dashboard (Team page) isn't background-polled — it syncs on demand when you open their
  section, then is served from cache (revalidated in the background if it's more than 5 minutes old).
- Everything fetched from Azure DevOps is cached to disk under `.cache/`, which is what makes
  restarts fast. **Deleting `.cache/` is a safe way to force a full clean resync** — it just costs one
  slow first sync again, same as a brand-new clone.

---

## Configuration reference

All of this lives in `.env` (copy `.env.example` to start). Only the first two are required.

| Key | Required | Default | What it does |
|---|---|---|---|
| `ADO_ORG` | yes | — | Your Azure DevOps organization name (the part before `.visualstudio.com`, or after `dev.azure.com/`). |
| `APP_PASSWORD` | yes | — | Shared team password, step 1 of sign-in. Everyone uses the same one. |
| `ADO_PROJECT` | no | — | Preselects this project on the sign-in project step. Not a restriction — each person picks from what their own token can read. |
| `ADO_PAT` | no | — | Shared "service" token for background polling and project-wide reads; a project it can't read falls back to the opener's own token. See [The ADO_PAT](#the-ado_pat). |
| `ADO_API_VERSION` | no | `7.1` | Azure DevOps REST API version. |
| `PORT` | no | `5174` | Port the server listens on. |
| `HOST` | no | `127.0.0.1` | Bind address. Leave as-is for local/IIS use; set to `0.0.0.0` in a container — see [Deploying for a team](#deploying-for-a-team). |
| `SYNC_INTERVAL_MS` | no | `180000` (3 min) | How often your own dashboard is refreshed in the background. |
| `ADO_PR_HISTORY_MONTHS` | no | `12` | How far back closed PRs are attributed/shown on the Pull Requests page (still-open PRs are always kept). `0` disables the cutoff. |
| `SESSION_SECRET` | no | generated | Key used to encrypt session cookies. Unset, one is generated and saved to `data/session-secret`; set it explicitly in production (`openssl rand -base64 32`). |
| `SESSION_TTL_HOURS` | no | `720` (30 days) | How long a signed-in session lasts. |
| `MAX_PROJECT_SCOPES` | no | `8` | How many projects stay resident in memory at once. Idle ones are dropped and repaint from disk when reopened. |
| `ADO_ROLES_WIKI_PAGE` | no | `/Dashboard Roles` | Path to the Dashboard Roles page, on each project's own `<project>.wiki`. |
| `ORG_DATA_DIR` | no | `./data/org` | Where the local fallback copies of each project's org chart live. The wiki is the durable copy. |
| `ADO_OWNER_EMAIL` | no | the `ADO_PAT` owner | Who gets "Clear Cache" / "Reload All Data", in every project. |

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Server refuses to start, prints "missing required configuration" | `ADO_ORG` or `APP_PASSWORD` isn't set in `.env`. Confirm you copied `.env.example` to `.env` (not left it as the template name) and filled in real values. |
| Sign-in says the token can't see any projects | The PAT was created in a different organization than `ADO_ORG`, or lacks **Project and Team (Read)**. |
| A project is listed at sign-in but rejected on Continue | Being listed only needs Project and Team (Read); the dashboard also needs **Work Items (Read & Write)** in that project. |
| Signed out unexpectedly, landing on the project step | The project on your session was deleted, renamed, or your access to it was revoked — pick another. Your password and token aren't asked for again. |
| Logging hours / changing state fails with **403** | Your PAT doesn't have Work Items (Read & **Write**). Re-check the token's scopes at `_usersSettings/tokens`. |
| Everything suddenly 401s | The PAT expired or was revoked. Issue a new one and update `.env`. |
| `EADDRINUSE`, or the server won't (re)start | Something is already listening on the port (an old, still-running process). See [Stopping and restarting](#stopping-and-restarting). |
| The "Team" tab is missing | The org chart doesn't list your email as `lead`/`principal`/`scrum` (and you're not the configured owner) — see [Team roles and membership](#team-roles-and-membership-for-leads-and-principals). Also check the server log for a wiki read/write error. |
| Manage Team edits don't survive a restart / redeploy | Your PAT's Wiki scope is Read-only — edits save to the local cache but the required wiki write silently can't happen, or fails loudly with a clear error. Re-grant **Wiki: Read & Write** (see [The ADO_PAT](#the-ado_pat)). |
| Dashboard is empty / no work items show | Confirm work items are actually assigned to your PAT's account in Azure DevOps, and that they're in a 2026-or-later sprint (older sprints are intentionally excluded from the grouped Work Items view — the Dashboard's "Recently updated" list is not subject to that cutoff). |
| First load takes a couple of minutes | Expected on a genuinely first run — see [First run, after cloning](#first-run-after-cloning). If it happens on *every* restart, `.cache/` isn't being written (check disk permissions) or is being deleted between runs. |

---

## Security notes

This is a small team tool, not a multi-tenant service, and its safeguards are designed for that:

- The server binds to `127.0.0.1` by default — nothing outside your own machine can reach it until
  you change `HOST`.
- Every deployment has the login gate: a shared password, then each person's own PAT, then the
  project they pick. Your token is your identity; there are no accounts to manage.
- Write actions (logging hours, changing state) are rejected server-side unless the target work item
  is actually assigned to the caller — the UI hiding those controls for teammates is a courtesy,
  not the real enforcement.
- The Team page's lead/principal gate is **organizational scoping**, not a hard security boundary —
  it stops the app from showing an "add a teammate" affordance to people it shouldn't, but it relies
  on the wiki page being edited honestly, the same trust level as any other content in the project
  wiki.

When [deployed for a team](#deploying-for-a-team) the server is reachable beyond your machine, so the
login gate — not the network — is what stands in for the loopback bind above. A few things worth
knowing:

- The shared `APP_PASSWORD` is one password for the whole team — anyone who has it (or leaks it) can
  reach step 2. It's rate-limited (5 attempts per 15 minutes per IP) but isn't a substitute for
  keeping it private, the same as you'd treat a shared Wi-Fi password.
- Each person's own PAT is what actually gates their access and identity — the password only gets you
  to the PAT prompt, and a wrong/no-access PAT is rejected there.
- Sessions are an encrypted cookie holding that PAT, not a server-side session store. Losing
  `SESSION_SECRET` (or an attacker obtaining it) is equivalent to obtaining every currently-signed-in
  person's PAT — treat it as sensitive as the PATs themselves, and set it only via your hosting
  platform's secret storage, never committed.
- HTTPS is required for this to be safe in practice — the session cookie is marked `Secure` in
  production, so it's simply not sent over plain HTTP. Don't deploy this behind a plain-HTTP endpoint.
