# Demo mode

Runs the unchanged app against a fictional organization ("Masar Technologies") so every page can be shown
and screenshotted without real data. Nothing here reads or writes the real organization, cache, settings
or sessions.

## Run it

```bash
npm install; npm install --prefix web
npm run demo          # guard -> build -> DEMO_MODE=1 server on port 5180
```

`npm run demo` rebuilds `web/dist`. If you also run the real app from the same checkout (for example as a
service whose `<workingdirectory>` is in `deploy/azure-dashboard.xml`), run the demo from a separate clone
or `git worktree` so the build does not replace the files the real app serves. The guard refuses to start
in the service folder.

## Sign in

| Step | Value |
|---|---|
| Password | `demo` |
| Token | `demo-lead` (team lead, all pages), `demo-member` (developer), `demo-principal` |
| Project | `Customer Experience Portal` (default), `Smart Operations Platform`, `Enterprise Cloud Platform` |

Add `?presentation=1` to any URL to hide the "Demo data" badge for the tab (`?presentation=0` brings it back).

## What it contains

- Three projects on three process templates: Agile (Customer Experience Portal), Scrum (Smart Operations Platform), and an
  Agile process with a custom `Spike` type and an `On Hold` state (Enterprise Cloud Platform, which has no wiki).
- 16 people (8 Egyptian, 8 Gulf/Saudi names, written in Arabic) in 4 Arabic-named teams; project names are English and work item titles mix Arabic with English technical terms. The lead (Mona Ahmed, written in Arabic in the app) works in all three projects. One person also carries a
  second, pre-migration identity.
- About 320 work items with full revision histories, about 90 pull requests across 5 repositories (two
  ship stories from another project), sprint capacity, and an org chart on each project's wiki page.
- Every situation a view exists for: cross-sprint child, blocked (tag, field, state) and stalled items,
  re-estimates (one over-distributed), scope added and removed, past ownership, a Removed item.
- Dates are relative to today (work week Sunday–Thursday), so it looks current whenever it runs.
  `DEMO_SEED` changes the generated content. The data is validated at startup; a seed too thin to show
  every feature refuses to start.

## Behaviour

- Writes (hours, state, sprint moves, team chart, blocked convention) work and are discarded on restart or
  `POST /api/demo/reset` (owner only). Authorization is the real code.
- `GET /api/demo/status` reports `realNetworkRequests` (must stay 0), `unhandled` Azure DevOps calls and
  `handlerErrors`. A new Azure DevOps call needs a matching route in `transport.js`, or `npm test` fails.
- Isolation: paths under `.demo/`, an in-memory session secret that never comes from `SESSION_SECRET`,
  cookie names `azdash_demo_*`, port 5180 (5174 refused), and `DEMO_MODE` read only from the process
  environment with exact values (`1/true/on`, `0/false/off`).

## Screenshots

```powershell
$env:NODE_PATH = "<path-to>/browser-tools/node_modules"
node tools/capture-demo.cjs [--only id,id] [--lang en|ar] [--theme light|dark]
```

Needs a deny list of real names outside the repo (`DEMO_DENYLIST`, default
`%USERPROFILE%\.azure-dashboard\denylist.txt`): at least 10 terms, one in Arabic script, covering the real
organization, the default project and every project opened on this machine. Fail-closed: any leak,
unreadable content, outside request or error aborts the run and publishes nothing. A passing run replaces
`.demo/shots/latest/` as a whole (76 images and a contact sheet); partial runs go to `.demo/shots/partial/`.
Shots are listed in `tools/demo-shots.json`.
