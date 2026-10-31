import type {
  AdoProject,
  ApiErrorBody,
  AuthMeResponse,
  BlockedConvention,
  BlockedConventionData,
  BulkIterationWriteResult,
  BurndownData,
  CrossHoursResponse,
  Dashboard,
  ImpedimentsData,
  IterationWriteResult,
  OrgMember,
  OrgResponse,
  OrgTeam,
  PastOwnedResult,
  PeopleResponse,
  Person,
  PrPage,
  PrRepoMatch,
  ScopeChangeData,
  ScrumEnvelope,
  ScrumSprintsData,
  SprintProgressData,
  StateWriteResult,
  StatesResponse,
  SyncProgress,
  TaskWriteResult,
  TeamResponse,
  UtilisationData,
  VelocityData,
} from './types';

export class ApiError extends Error {
  code: ApiErrorBody['code'];
  details?: ApiErrorBody['details'];
  constructor(body: ApiErrorBody) {
    super(body.error);
    this.code = body.code;
    this.details = body.details;
  }
}

/** Where the current visitor stands in the login gate — checked before
 * anything else renders (see RequireAuth). Never throws: a network error is
 * indistinguishable from "not signed in" as far as the gate is concerned. */
export async function fetchAuthMe(): Promise<AuthMeResponse> {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!res.ok) return { authEnabled: true, stage: 'password' };
  return res.json();
}

export async function submitPassword(password: string): Promise<void> {
  const res = await fetch('/api/auth/password', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
}

/** Accepting the PAT also answers "which projects can it read?" in the same
 * round trip, so the project step usually renders with no further request. */
export async function submitPat(pat: string): Promise<{ self: AuthMeResponse['self']; projects: AdoProject[] }> {
  const res = await fetch('/api/auth/pat', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pat }),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  const body = data as { self: AuthMeResponse['self']; projects?: AdoProject[] };
  return { self: body.self, projects: body.projects || [] };
}

/** Re-fetches the project list for a session that's past the PAT step but has
 * no list in hand — e.g. the page was reloaded on the project step. */
export async function fetchProjects(): Promise<{ projects: AdoProject[]; defaultProject: string | null }> {
  const res = await fetch('/api/auth/projects', { credentials: 'same-origin' });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  const body = data as { projects: AdoProject[]; defaultProject?: string | null };
  return { projects: body.projects, defaultProject: body.defaultProject ?? null };
}

/** The last step of sign-in: binds a project to the session. Everything the
 * app shows afterwards comes from that project. */
export async function submitProject(project: string): Promise<void> {
  const res = await fetch('/api/auth/project', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project }),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
}

const LOGIN_REASON_KEY = 'azdash:login-reason';

/** Reads and clears the one-shot reason set by `redirectToLogin` below —
 * called once by LoginPage on mount so the message shows exactly once,
 * not on every future visit to /login. */
export function readAndClearLoginReason(): string | null {
  try {
    const reason = sessionStorage.getItem(LOGIN_REASON_KEY);
    if (reason) sessionStorage.removeItem(LOGIN_REASON_KEY);
    return reason;
  } catch {
    return null;
  }
}

/** A session that expired (or was revoked by a SESSION_SECRET rotation)
 * shows up as a 401 on whatever request happened to run next — there's no
 * separate "you're logged out" push. A hard redirect is simpler and more
 * reliable here than trying to thread this through React Query's error
 * state for every single query. `reason` (e.g. "your PAT expired") is
 * stashed for LoginPage to show once, since the redirect itself throws
 * away any in-memory state. */
function redirectToLogin(reason?: string): never {
  if (reason) {
    try {
      sessionStorage.setItem(LOGIN_REASON_KEY, reason);
    } catch {
      // best-effort; sessionStorage may be disabled
    }
  }
  window.location.href = '/login';
  throw new Error('UNAUTHENTICATED');
}

/** Same "explain a PAT_EXPIRED/PROJECT_UNAVAILABLE 401" logic postJson below
 * already applies to writes, for the plain-`fetch` read helpers (dashboard,
 * PR paging) that don't route through postJson/getJson — without this they
 * bounced to /login with no reason at all, leaving an automatic sign-out
 * indistinguishable from any other one. */
async function redirectToLoginExplained(res: Response): Promise<never> {
  const data = (await res.json().catch(() => null)) as ApiErrorBody | null;
  const explained = data && (data.code === 'PAT_EXPIRED' || data.code === 'PROJECT_UNAVAILABLE');
  return redirectToLogin(explained ? data.error : undefined);
}

export async function fetchDashboard(personId: string | null): Promise<Dashboard> {
  const url = personId ? `/api/dashboard?person=${encodeURIComponent(personId)}` : '/api/dashboard';
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) await redirectToLoginExplained(res);
  if (res.status === 202) {
    throw new Error('SYNCING');
  }
  if (!res.ok) {
    throw new Error(`Failed to load dashboard: ${res.status}`);
  }
  return res.json();
}

/** Pages one repo's PR list — see GET /api/pullrequests in server/index.js.
 * Same `202` -> `SYNCING` convention as `fetchDashboard`, since a repo's PRs
 * can't be paged before a first sync has built the PR index. */
export async function fetchPrPage(params: {
  personId: string | null;
  repositoryId: string;
  offset: number;
  limit: number;
  status?: string | null;
  q?: string;
}): Promise<PrPage> {
  const query = new URLSearchParams({
    repo: params.repositoryId,
    offset: String(params.offset),
    limit: String(params.limit),
  });
  if (params.personId) query.set('person', params.personId);
  if (params.status) query.set('status', params.status);
  if (params.q) query.set('q', params.q);

  const res = await fetch(`/api/pullrequests?${query.toString()}`, { credentials: 'same-origin' });
  if (res.status === 401) await redirectToLoginExplained(res);
  if (res.status === 202) {
    throw new Error('SYNCING');
  }
  if (res.status === 429) {
    throw new Error('RATE_LIMITED');
  }
  if (!res.ok) {
    throw new Error(`Failed to load pull requests: ${res.status}`);
  }
  return res.json();
}

/** Which repos have at least one PR matching the current status/search
 * filter — see GET /api/pullrequests/repos. One request instead of paging
 * every repo just to discover which ones are empty. */
export async function fetchPrRepoMatches(params: {
  personId: string | null;
  status?: string | null;
  q?: string;
}): Promise<{ repos: PrRepoMatch[] }> {
  const query = new URLSearchParams();
  if (params.personId) query.set('person', params.personId);
  if (params.status) query.set('status', params.status);
  if (params.q) query.set('q', params.q);

  const res = await fetch(`/api/pullrequests/repos?${query.toString()}`, { credentials: 'same-origin' });
  if (res.status === 401) await redirectToLoginExplained(res);
  if (res.status === 202) {
    throw new Error('SYNCING');
  }
  if (res.status === 429) {
    throw new Error('RATE_LIMITED');
  }
  if (!res.ok) {
    throw new Error(`Failed to load pull request repos: ${res.status}`);
  }
  return res.json();
}

/** `refresh: true` asks the server to bypass ROLES_CACHE_TTL_MS (rate-limited
 * server-side to one wiki fetch per person per 30s) so a role change on the
 * Dashboard Roles wiki page — e.g. someone just added as a lead — takes
 * effect immediately rather than after up to 10 minutes. The people list
 * itself is unaffected; only the role lookup is force-refreshed. */
export async function fetchPeople(opts: { refresh?: boolean } = {}): Promise<PeopleResponse> {
  const url = opts.refresh ? '/api/people?refresh=1' : '/api/people';
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`Failed to load people: ${res.status}`);
  return res.json();
}

/** Live directory search for someone missing from the cached people list
 * (no team, no recent assigned work). Used as a fallback when the local
 * filter over `usePeople()` comes up empty. */
export async function searchPeople(query: string): Promise<Person[]> {
  const res = await fetch(`/api/people/search?q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`People search failed: ${res.status}`);
  const data = (await res.json()) as { people: Person[] };
  return data.people;
}

/** GET /api/workitems/search — items in this project `personId` (or the
 * caller, when omitted) was EVER assigned and is not assigned now, matching
 * `query`. See contracts/search-workitems.md. Read-only; the client never
 * merges this into the dashboard payload (research.md R2). */
export async function searchWorkItems(
  query: string,
  personId?: string | null
): Promise<{ results: PastOwnedResult[]; truncated: boolean; query: string }> {
  const params = new URLSearchParams({ q: query });
  if (personId) params.set('person', personId);
  const res = await fetch(`/api/workitems/search?${params.toString()}`, { credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`Work item search failed: ${res.status}`);
  return res.json();
}

export async function fetchStates(): Promise<StatesResponse> {
  const res = await fetch('/api/states', { credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`Failed to load states: ${res.status}`);
  return res.json();
}

/** Polled while a sync is in flight for `personId` — must never surface as
 * an error state, so any non-OK response is treated the same as "nothing
 * running right now" rather than thrown. */
export async function fetchSyncProgress(personId: string | null): Promise<SyncProgress | null> {
  const url = personId ? `/api/sync/progress?person=${encodeURIComponent(personId)}` : '/api/sync/progress';
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = (await res.json()) as { progress: SyncProgress | null };
    return data.progress;
  } catch {
    return null;
  }
}

/** Cross-project hours — see GET /api/hours/cross. `personId` asks about a
 * teammate (the Team page's card); omitted, it answers about the signed-in
 * person. Either way the projects covered are the ones the CALLER's token can
 * read. A first build can take minutes, which is why this returns a
 * `building` status to poll rather than a long-held request. */
export async function fetchCrossHours(personId?: string | null): Promise<CrossHoursResponse> {
  const url = personId ? `/api/hours/cross?person=${encodeURIComponent(personId)}` : '/api/hours/cross';
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`Failed to load cross-project hours: ${res.status}`);
  return res.json();
}

export async function triggerSync(personId: string | null): Promise<void> {
  const res = await fetch('/api/sync', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person: personId }),
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
}

export interface FullSyncResult {
  syncedAt: string;
  backgroundCount: number;
}

/** "Reload All Data": forces every shared cache and this person's dashboard
 * to refetch from Azure DevOps right now, plus (in the background) every
 * teammate with a cached dashboard. Can take tens of seconds — the only
 * request in the app with an explicit timeout, so a hung server fails the
 * button instead of leaving it spinning forever. */
export async function triggerFullSync(personId: string | null): Promise<FullSyncResult> {
  const res = await fetch('/api/sync/full', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ person: personId }),
    signal: AbortSignal.timeout(120_000),
  });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`Full sync failed: ${res.status}`);
  return res.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    // Read the body before redirecting so a PAT_EXPIRED write failure (this
    // person's own token specifically, see server's handleWriteError) can
    // show a clear reason on the login screen instead of a bare bounce.
    const data = (await res.json().catch(() => null)) as ApiErrorBody | null;
    // PROJECT_UNAVAILABLE is the same idea one step later: the session is
    // fine, the project it was bound to isn't, and the login screen will open
    // straight on the project step — say why rather than bouncing silently.
    const explained = data && (data.code === 'PAT_EXPIRED' || data.code === 'PROJECT_UNAVAILABLE');
    redirectToLogin(explained ? data.error : undefined);
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  return data as T;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  return data as T;
}

async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) redirectToLogin();
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  return data as T;
}

async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  return data as T;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) redirectToLogin();
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  return data as T;
}

/** Logs hours worked today on a task. The server re-reads the task's
 * current values from Azure DevOps before applying the delta — never
 * trust the dashboard's own cached numbers for a write. Always operates on
 * your own tasks; the server rejects this if the resolved caller isn't you. */
export function logTaskHours(taskId: number, hours: number): Promise<TaskWriteResult> {
  return postJson(`/api/tasks/${taskId}/log-hours`, { hours });
}

/** Sets a task's CompletedWork as a percentage of its Original Estimate.
 * Converted against the live estimate (see fetchTaskHours below), which is
 * what the edit panel previews against before letting you drag this. */
export function setTaskProgress(taskId: number, pct: number): Promise<TaskWriteResult> {
  return postJson(`/api/tasks/${taskId}/set-progress`, { pct });
}

/** Live hours for one task, re-read from Azure DevOps just now — used to
 * preview a change against the real current estimate instead of the
 * dashboard's own cached (possibly stale) copy. */
export function fetchTaskHours(taskId: number): Promise<{ estimated: number; completed: number; remaining: number; state: string | null }> {
  return getJson(`/api/tasks/${taskId}/hours`);
}

/** Changes a work item's state directly. Always operates on your own items;
 * the server rejects this if the resolved caller isn't you. */
export function setWorkItemState(id: number, state: string): Promise<StateWriteResult> {
  return postJson(`/api/workitems/${id}/state`, { state });
}

/** Moves a task/bug onto its parent story's current sprint. The target
 * iteration is resolved server-side from the item's real parent in Azure
 * DevOps — never sent by the client. Always operates on your own items;
 * the server rejects this if the resolved caller isn't you. */
export function moveToParentIteration(id: number): Promise<IterationWriteResult> {
  return postJson(`/api/workitems/${id}/move-to-parent-iteration`, {});
}

/** Moves every one of a story's children (tasks/bugs) that you own and that
 * aren't already on the story's sprint. Partial failures don't reject the
 * call — check `failed` on the result. */
export function moveStoryChildrenToIteration(storyId: number): Promise<BulkIterationWriteResult> {
  return postJson(`/api/stories/${storyId}/move-children-to-iteration`, {});
}

/** The caller's own role plus their roster from the org chart
 * (server/orgStore.js) — read-only here; the roster itself is edited from
 * the Team page's "Manage team" modal (see useOrg.ts). 403s for anyone not
 * listed as a lead/principal/scrum — the caller should treat that the same
 * as "feature not available", not surface it as an error. */
export async function fetchTeam(opts: { refresh?: boolean } = {}): Promise<TeamResponse> {
  const url = opts.refresh ? '/api/team?refresh=1' : '/api/team';
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`Failed to load team: ${res.status}`);
  return res.json();
}

/** The caller's own subtree of the org chart (server/orgStore.js) — the
 * dashboard owner sees everything, a team lead sees only their own subtree.
 * See ManageTeamModal.tsx. */
export function fetchOrg(): Promise<OrgResponse> {
  return getJson('/api/org');
}

/** `managerMemberId` is required — a team always has a manager, and the
 * server no longer falls back to the caller (which used to make the owner
 * the lead of every team they created). */
export function createOrgTeam(name: string, managerMemberId: string): Promise<{ team: OrgTeam }> {
  return postJson('/api/org/teams', { name, managerMemberId });
}

export function updateOrgTeam(id: string, patch: { name?: string; managerMemberId?: string | null }): Promise<{ team: OrgTeam }> {
  return patchJson(`/api/org/teams/${encodeURIComponent(id)}`, patch);
}

/** `cascade` deletes the team's members along with it. Without it the server
 * refuses a populated team with a TEAM_NOT_EMPTY error naming the count, so
 * the destructive version is always something the user opted into. */
export function deleteOrgTeam(id: string, cascade = false): Promise<{ ok: true }> {
  return deleteJson(`/api/org/teams/${encodeURIComponent(id)}${cascade ? '?cascade=1' : ''}`);
}

export interface CreateOrgMemberInput {
  email: string;
  displayName?: string;
  role: OrgMember['role'];
  teamId?: string | null;
  /** Null creates a chart root — a newly minted team manager, who must not
   * be auto-parented under the owner. Server-side that is owner-only. */
  parentId: string | null;
}

export function createOrgMember(input: CreateOrgMemberInput): Promise<{ member: OrgMember }> {
  return postJson('/api/org/members', input);
}

/** `reassignReports` is not a member field — it is the caller confirming that
 * lowering someone's role may first move their direct reports up to their own
 * manager. Without it the server refuses such a change with
 * REPORTS_REASSIGN_REQUIRED and a message naming who moves where. */
export type UpdateOrgMemberPatch = Partial<Omit<OrgMember, 'id' | 'email'>> & { reassignReports?: boolean };

export function updateOrgMember(id: string, patch: UpdateOrgMemberPatch): Promise<{ member: OrgMember }> {
  return patchJson(`/api/org/members/${encodeURIComponent(id)}`, patch);
}

export function deleteOrgMember(id: string): Promise<{ ok: true }> {
  return deleteJson(`/api/org/members/${encodeURIComponent(id)}`);
}

/** GET /api/scrum/sprints — the shared selector every Scrum card is bound
 * to. 403s the same way fetchTeam does: not-a-lead/principal/scrum is an
 * expected steady state, not a transient error worth retrying. */
export async function fetchScrumSprints(): Promise<ScrumEnvelope<ScrumSprintsData>> {
  const res = await fetch('/api/scrum/sprints', { credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  return data as ScrumEnvelope<ScrumSprintsData>;
}

/** GET /api/scrum/velocity — US1. `windowSize` follows DEFAULT_SPRINT_WINDOW
 * server-side when omitted. */
export async function fetchScrumVelocity(windowSize?: number): Promise<ScrumEnvelope<VelocityData>> {
  const url = windowSize ? `/api/scrum/velocity?window=${windowSize}` : '/api/scrum/velocity';
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  const data = await res.json();
  if (!res.ok) throw new ApiError(data as ApiErrorBody);
  return data as ScrumEnvelope<VelocityData>;
}

/** Every per-sprint Scrum view shares the same `?sprint=` shape — one helper
 * rather than five near-identical fetch functions. */
function scrumSprintUrl(base: string, sprintPath: string | null): string {
  return sprintPath ? `${base}?sprint=${encodeURIComponent(sprintPath)}` : base;
}

export async function fetchScrumProgress(sprintPath: string | null): Promise<ScrumEnvelope<SprintProgressData>> {
  return getJson(scrumSprintUrl('/api/scrum/progress', sprintPath));
}

export async function fetchScrumUtilisation(sprintPath: string | null): Promise<ScrumEnvelope<UtilisationData>> {
  return getJson(scrumSprintUrl('/api/scrum/utilisation', sprintPath));
}

export async function fetchScrumBurndown(sprintPath: string | null): Promise<ScrumEnvelope<BurndownData>> {
  return getJson(scrumSprintUrl('/api/scrum/burndown', sprintPath));
}

export async function fetchScrumImpediments(sprintPath: string | null): Promise<ScrumEnvelope<ImpedimentsData>> {
  return getJson(scrumSprintUrl('/api/scrum/impediments', sprintPath));
}

export async function fetchScrumScopeChange(sprintPath: string | null): Promise<ScrumEnvelope<ScopeChangeData>> {
  return getJson(scrumSprintUrl('/api/scrum/scope-change', sprintPath));
}

export async function fetchBlockedConvention(sprintPath: string | null): Promise<{ data: BlockedConventionData }> {
  return getJson(scrumSprintUrl('/api/scrum/blocked-convention', sprintPath));
}

export async function saveBlockedConvention(
  convention: BlockedConvention,
  sprintPath: string | null
): Promise<{ data: { convention: BlockedConvention } }> {
  // Must carry the same sprint GET was called with — the server validates
  // tags against that sprint's own items, and a mismatch 400s a tag the
  // editor itself just offered.
  return putJson(scrumSprintUrl('/api/scrum/blocked-convention', sprintPath), convention);
}

export async function clearCache(): Promise<void> {
  const res = await fetch('/api/cache/clear', { method: 'POST', credentials: 'same-origin' });
  if (res.status === 401) redirectToLogin();
  if (!res.ok) throw new Error(`Cache clear failed: ${res.status}`);
}

/** ONE EventSource for the whole tab, shared by every subscriber and
 * reference-counted, opened on the first subscribe and closed on the last
 * unsubscribe.
 *
 * This must never become per-subscriber again. `useDashboard` subscribes
 * once per mounted hook, and the Team page mounts one of those PER SELECTED
 * MEMBER — so a socket-per-subscriber meant N members = N permanently-open
 * connections. Browsers cap concurrent HTTP/1.1 connections to an origin at
 * six, and an SSE stream never closes, so a handful of selected members ate
 * every slot in the tab and starved every other request: "Manage team"
 * (GET /api/org) would spin forever with nothing reaching the server, and
 * only deselecting members freed a connection for it. The stream carries
 * the person id in its payload, so one socket serves everyone — subscribers
 * already filter on it themselves. */
let sharedSource: EventSource | null = null;
const updateListeners = new Set<(personId: string) => void>();

export function subscribeToUpdates(onUpdate: (personId: string) => void): () => void {
  updateListeners.add(onUpdate);

  if (!sharedSource) {
    sharedSource = new EventSource('/api/stream');
    sharedSource.addEventListener('dashboard-updated', (e) => {
      let personId: string;
      try {
        personId = JSON.parse((e as MessageEvent).data).personId;
      } catch {
        return; // malformed event — ignore rather than crash the subscription
      }
      // Snapshot: a handler may unsubscribe (unmount) during the loop.
      for (const listener of [...updateListeners]) listener(personId);
    });
  }

  return () => {
    updateListeners.delete(onUpdate);
    if (updateListeners.size === 0 && sharedSource) {
      sharedSource.close();
      sharedSource = null;
    }
  };
}
