export type ProgressBasis = 'hours' | 'state';
export type CompletionBasis = 'hours' | 'tasks' | 'state';

export interface Hours {
  estimated: number;
  completed: number;
  remaining: number;
}

export interface Reviewer {
  name: string;
  vote: number;
}

export interface PullRequest {
  id: number;
  title: string;
  status: string;
  isDraft: boolean;
  repository: string | null;
  repositoryId: string | null;
  projectId: string | null;
  projectName: string | null;
  createdDate: string | null;
  closedDate: string | null;
  url: string | null;
  reviewers: Reviewer[];
}

/** A minimal reference to a work item's parent, carried by a child rendered
 * away from it — either a cross-sprint-promoted card (see IterationGroup.
 * crossSprintItems) or a past-owned search result. Built server-side from the
 * already-hydrated parent; no extra ADO call. See data-model.md §1. */
export interface ParentRef {
  id: number;
  title: string;
  type: string;
  iterationPath: string | null;
}

export interface Task {
  id: number;
  type: string;
  title: string;
  description: string;
  state: string;
  stateCategory: string | null;
  blocked: boolean;
  createdDate: string | null;
  changedDate: string | null;
  dueDate: string | null;
  iterationPath: string | null;
  assignedTo: string | null;
  hours: Hours;
  progressPct: number;
  progressBasis: ProgressBasis;
  pullRequests: PullRequest[];
  parentId: number | null;
  /** Populated ONLY on a promoted (cross-sprint) rendering and on a
   * past-owned search result that has a parent. `null` everywhere else,
   * including the same task nested under its own story — where the parent
   * is already on screen. See data-model.md §2. */
  parentRef: ParentRef | null;
  /** 006-linked-identity-aliases (FR-008): true only when this item's real
   * current assignee is the signed-in PRIMARY identity — false for an item
   * still assigned to a linked (e.g. retired-domain) identity. A UI
   * courtesy only: the server independently refuses the write regardless
   * (assertAssignedTo in ado/writeback.js), so this gates which controls
   * are even offered, never enforcement. Defaults to `true` when absent
   * (an older cached payload, or a shape this field hasn't reached yet),
   * matching pre-widening behaviour exactly. */
  editable?: boolean;
  /** 007-all-assigned-types: false when this item's TYPE has no Completed
   * Work field (e.g. a Feature), so no hours editor is offered. Absent ⇒ true
   * (an older cached payload). A UI courtesy only — the server refuses the
   * write with TYPE_NO_HOURS regardless. Never set on stories, whose hours
   * are a rollup. */
  hoursEditable?: boolean;
}

export interface Story {
  id: number;
  title: string;
  type: string;
  state: string;
  stateCategory: string | null;
  blocked: boolean;
  createdDate: string | null;
  changedDate: string | null;
  dueDate: string | null;
  iterationPath: string | null;
  repository: string | null;
  hours: Hours;
  completionPct: number;
  completionBasis: CompletionBasis;
  tasks: Task[];
  pullRequests: PullRequest[];
  hiddenTaskCount: number;
  parentId: number | null;
  /** 006-linked-identity-aliases (FR-008) — see Task.editable's own comment;
   * a Story is itself a directly-assignable work item and gets the same
   * treatment. */
  editable?: boolean;
}

/** One entry in the dashboard's "Recently updated work items" list — mirrors
 * ADO's own "Recently updated" page, scoped to this person. `kind` picks
 * which real card component renders it (StoryCard/TaskCard), so it looks
 * and behaves identically to the Work Items page. */
export type RecentItem = { kind: 'story'; story: Story } | { kind: 'task'; task: Task };

export interface IterationGroup {
  iterationPath: string | null;
  iterationName: string;
  startDate: string | null;
  finishDate: string | null;
  isLatest: boolean;
  hours: Hours;
  stories: Story[];
  unparentedItems: Task[];
  /** Children whose own iterationPath resolves to THIS group but whose parent
   * story sits in a different sprint — each carries `parentRef`. Always an
   * array, never undefined, so no client-side guard is needed. Excluded from
   * `hours` above by construction: a promoted child's hours are already
   * counted inside its parent story's rollup, in the parent's own group.
   * See data-model.md §3. */
  crossSprintItems: Task[];
}

/** Response shape of one match from GET /api/workitems/search — never part
 * of the dashboard payload. See data-model.md §4 and
 * contracts/search-workitems.md. */
export interface PastOwnedResult {
  item: Task;
  /** Display name of whoever holds it now; null means unassigned. Verbatim
   * — render inside <Foreign>. */
  currentAssignee: string | null;
  /** ISO date of the most recent revision where the person held it, when
   * cheaply available; null otherwise. Display-only, never sorted on. */
  lastAssignedToPerson: string | null;
}

/** A story as it appears on the Pull Requests page, grouped under its
 * repository — see server/ado/prAttribution.js for how a PR is resolved to
 * the story it belongs to. */
export interface PrStoryBlock {
  id: number;
  type: string;
  title: string;
  state: string;
  pullRequests: PullRequest[];
}

/** A work item found while trying to attribute a PR (its title, ADO's own
 * linked-items list, or a commit message) that didn't resolve to any
 * story — shown as a tag on the PR card instead of being silently dropped. */
export interface LinkedItem {
  id: number;
  type: string;
  title: string;
}

export interface UnattributedPr extends PullRequest {
  linkedItems: LinkedItem[];
}

/** One repo's PR summary as shipped in the dashboard payload — counts only,
 * no PR bodies (those are paged in on demand via GET /api/pullrequests, see
 * lib/api.ts's `fetchPrPage`). `statusCounts` mirrors `prStatusId` exactly
 * (server/compute/prGroups.js's `prStatusId`), so chip counts always agree
 * with how a PR is actually badged. */
export interface PrRepoSummary {
  repository: string;
  repositoryId: string | null;
  projectName: string | null;
  prCount: number;
  statusCounts: { active: number; draft: number; completed: number; abandoned: number };
}

/** One repo's match count under the current status/search filter — see
 * GET /api/pullrequests/repos. Repos with zero matches are never included,
 * which is what lets the Pull Requests page render only repos that
 * actually have something to show instead of guessing from unfiltered
 * counts. */
export interface PrRepoMatch {
  repositoryId: string | null;
  repository: string;
  projectName: string | null;
  matchCount: number;
}

/** One page of one repo's PRs — the GET /api/pullrequests response shape.
 * `total` is the count after any `status`/`q` filtering but before the
 * `offset`/`limit` slice, so a "Load more" button knows when to stop. */
export interface PrPage {
  repository: string | null;
  repositoryId: string | null;
  projectName: string | null;
  stories: PrStoryBlock[];
  unattributed: UnattributedPr[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface TimelinePoint {
  period: string;
  hours: number;
}

export interface DayHours {
  date: string;
  hours: number;
}

/** One work item's contribution to a day's logged hours — the source data
 * for the Hours logged drill-down. */
export interface HourEntry {
  id: number;
  title: string;
  type: string;
  hours: number;
  /** Which project the item lives in. Only set on the cross-project series
   * (GET /api/hours/cross) — within one project it would be the same value on
   * every row, so the per-project payload leaves it out. */
  project?: string;
}

/** The current (or, on Fri/Sat, just-completed) Sunday-Thursday work week's
 * average hours per day, each day capped at 8h before averaging, plus that
 * average expressed as a utilization percentage against an 8h day. See
 * server/compute/timeline.js's buildTimeline() for how this is derived. */
export interface WeeklyAverage {
  /** YYYY-MM-DD — the Sunday this window starts on. */
  weekStart: string;
  /** 1..5 — Sun=1 ... Thu=5; Fri/Sat also read 5 (the completed week). */
  daysElapsed: number;
  /** 0..8, 2-decimal rounded. */
  hoursPerDay: number;
  /** 0..100, integer. */
  utilizationPct: number;
}

export interface Timeline {
  daily: TimelinePoint[];
  weekly: TimelinePoint[];
  monthly: TimelinePoint[];
  last7Days: DayHours[];
  today: DayHours;
  yesterday: DayHours;
  thisWeek: TimelinePoint;
  thisMonth: TimelinePoint;
  // Optional: a dashboard cached on disk from before this field existed has
  // no `weeklyAverage` key at all and is served as-is (no cache-schema
  // version guard the way revisionIndex.js has one) — HoursStrip.tsx must
  // tolerate that rather than crash the whole page on a stale entry.
  weeklyAverage?: WeeklyAverage;
  averageDailyProductivity: number;
  activeDays: number;
  totalHours: number;
  /** Per-day work item breakdown, keyed by date (YYYY-MM-DD) — covers the
   * same days as `last7Days` only. */
  breakdown: Record<string, HourEntry[]>;
}

/** Progress of a cross-project hours build: which project of how many is
 * being walked. Project-level granularity only — a cold revision-index walk
 * inside one project reports pages to that project's own sync progress, not
 * here. */
export interface CrossHoursProgress {
  done: number;
  total: number | null;
  project: string | null;
  /** Waiting its turn behind another build — builds are serialised so several
   * open Team sections don't walk projects under one token at once. */
  queued?: boolean;
}

/** GET /api/hours/cross. `building` is the first-build state (minutes, if
 * several projects have never been opened); a `ready` result that is `stale`
 * is the previous answer, already being rebuilt behind the response. */
export type CrossHoursResponse =
  | { status: 'building'; progress: CrossHoursProgress | null }
  | {
      status: 'ready';
      stale?: boolean;
      builtAt: number;
      /** Whose hours these are — the caller, or the teammate asked about. */
      person: { id: string; displayName: string };
      self: boolean;
      timeline: Timeline;
      /** Only the projects with hours on the books, most hours first. */
      projects: { name: string; hours: number }[];
      projectsScanned: number;
      skipped: { name: string; reason: string }[];
    };

export interface Summary {
  openPullRequests: number;
  hiddenByStateCount: number;
  hiddenByIterationCount: number;
}

export interface TaskWriteResult {
  id: number;
  rev: number;
  hours: Hours;
  closed: boolean;
  activated: boolean;
  storyActivated: boolean;
  newState: string | null;
}

export interface StateWriteResult {
  id: number;
  rev: number;
  state: string;
}

export interface IterationWriteResult {
  id: number;
  rev: number;
  iterationPath: string | null;
  moved: boolean;
}

export interface BulkIterationWriteResult {
  storyId: number;
  iterationPath: string | null;
  moved: number[];
  failed: { id: number; message: string }[];
  skipped: number;
}

export interface WorkItemState {
  name: string;
  category: string;
  color: string | null;
}

/** Real per-type workflow states from Azure DevOps, keyed by work item type. */
export type StatesResponse = Record<string, WorkItemState[]>;

export interface ApiErrorBody {
  error: string;
  code:
    | 'VALIDATION'
    | 'CONFLICT'
    | 'ADO_ERROR'
    | 'FORBIDDEN'
    | 'UNAUTHENTICATED'
    | 'GATE_EXPIRED'
    | 'INVALID_PAT'
    | 'PAT_NO_ACCESS'
    | 'RATE_LIMITED'
    | 'PAT_EXPIRED'
    // Project selection (the last step of sign-in) and its aftermath — see
    // POST /api/auth/project and the onRequest hook in server/index.js.
    | 'PAT_NO_PROJECTS'
    | 'UNKNOWN_PROJECT'
    | 'PROJECT_NO_ACCESS'
    | 'PROJECT_REQUIRED'
    | 'PROJECT_UNAVAILABLE'
    // This project has no wiki, so the org chart has nowhere durable to live
    // (see server/orgStore.js) — a one-time setup step in Azure DevOps, not a
    // dashboard fault.
    | 'WIKI_MISSING'
    // The wiki exists but the configured page path doesn't resolve — a
    // deployment-config problem (ADO_ROLES_WIKI_PAGE), distinct from a project
    // that has no wiki at all. See server/orgStore.js `_save`.
    | 'WIKI_PAGE_INVALID'
    // Two org-chart refusals the Manage Teams UI turns into a confirmation
    // step rather than a dead end — see server/orgStore.js. The message
    // carries the detail (how many people, and where they'd go); the code
    // only says "this is recoverable if they say yes".
    | 'REPORTS_REASSIGN_REQUIRED'
    | 'TEAM_NOT_EMPTY'
    // 007-all-assigned-types: an hours write to a work item whose type has no
    // Completed Work field — refused before anything reaches Azure DevOps.
    | 'TYPE_NO_HOURS';
  details?: ApiErrorDetails;
}

/** Optional structured detail for specific error codes so Arabic sentences can
 * interpolate real numbers and names. Only certain codes emit this. */
export interface ApiErrorDetails {
  memberCount?: number;        // TEAM_NOT_EMPTY: how many members block the delete
  reportCount?: number;        // REPORTS_REASSIGN_REQUIRED: how many reports need reassignment
  newManagerName?: string;     // REPORTS_REASSIGN_REQUIRED: who they're reassigned to
}

/** GET /api/auth/me: where the current visitor is in the three-step gate —
 * shared password, then their own PAT, then which project to work in. */
export type AuthStage = 'password' | 'pat' | 'project' | 'ready';

/** One entry in the project list a token can read — see GET /api/auth/projects. */
export interface AdoProject {
  id: string;
  name: string;
  description: string | null;
  visibility: string | null;
}

export interface AuthMeResponse {
  authEnabled: boolean;
  /** Present (true) only when the server runs in demo mode, serving a
   * fictional organization; absent otherwise. */
  demo?: boolean;
  stage: AuthStage;
  org?: string;
  /** The project bound to this session. Present once stage === 'ready'; it is
   * what every route serves from. Changed in place by the account menu's
   * Switch project row (components/ProjectSwitcher.tsx) — the same
   * POST /api/auth/project the login step uses, no re-authentication. */
  project?: { id: string; name: string };
  /** ADO_PROJECT, if the deployment set one — preselected on the project step
   * and nothing more. Present on stage === 'project'. */
  defaultProject?: string | null;
  self?: { id: string; displayName: string; uniqueName: string | null };
  /** The token this project's shared reads run under was rejected (401) —
   * sprints, roster and hours history are stale/broken for everyone on this
   * project until it's rotated. Only meaningful once stage === 'ready'. */
  serviceTokenInvalid?: boolean;
}

export interface BlockedSignal {
  kind: 'state' | 'field' | 'tag';
  field: string;
  value: string;
  unconfirmed?: boolean;
}

export interface Person {
  id: string;
  displayName: string;
  uniqueName?: string;
}

/** Whoever the org chart (server/orgStore.js) lists the PAT owner as — null
 * for everyone not in the chart. `lead`/`principal`/`scrum` gate the Team
 * page; `scrum` additionally hides Pull Requests everywhere. See
 * server/org.js's capability helpers — every gate should read a flag off
 * `useMe()`, never compare this string directly. */
export type Role = 'developer' | 'lead' | 'principal' | 'scrum' | null;

/** 006-linked-identity-aliases: another Azure DevOps identity sharing the
 * signed-in person's username (e.g. their retired-domain account before a
 * sign-in migration) — see server/identitySet.js. Rendered verbatim, never
 * translated (wrap in `<Foreign>`): it is an ADO-sourced address, exactly
 * like a person name or state name. */
export interface LinkedIdentity {
  id: string;
  displayName: string;
  uniqueName: string;
}

export interface PeopleResponse {
  self: {
    id: string;
    displayName: string;
    uniqueName: string | null;
    role: Role;
    isOwner: boolean;
    canSeePullRequests: boolean;
    canSeeTeamPage: boolean;
    canAdminOrg: boolean;
    /** Always an array — [] for the common single-identity case (FR-009). */
    linkedIdentities: LinkedIdentity[];
    /** True only when identity-set discovery could not complete (FR-005) —
     * the view may be missing a linked identity it would otherwise show. */
    identitiesDegraded: boolean;
  };
  people: Person[];
}

/** One selectable group on the Team page's "Show members" picker — either a
 * whole team (a direct report who is a lead/principal/scrum, plus everyone
 * `rosterFor` reaches beneath them) or the bucket of direct developer
 * reports with no subtree of their own. `memberIds` are ADO person ids, so
 * selecting a group and an individual within it dedupes for free (see
 * TeamPage.tsx's `selectedIds` Set). */
export interface TeamGroup {
  id: string;
  label: string;
  memberIds: string[];
}

export interface TeamResponse {
  role: Role;
  members: Person[];
  groups: TeamGroup[];
  /** False when this project has no wiki holding an org chart — an empty
   * roster then means "nothing set up in this project yet", not "you have no
   * team". See server/orgStore.js. */
  wikiAvailable?: boolean | null;
}

/** One node in the org chart (server/orgStore.js) — teams and reporting
 * lines edited from the Team page's "Manage team" modal. `managerMemberId`
 * (nullable) names the member who heads the team — used server-side to
 * scope who may edit it. */
export interface OrgTeam {
  id: string;
  name: string;
  managerMemberId: string | null;
}

export interface OrgMember {
  id: string;
  email: string;
  displayName: string;
  role: Exclude<Role, null>;
  teamId: string | null;
  parentId: string | null;
}

/** GET /api/org — the caller's own row (read-only) plus every descendant,
 * scoped server-side; the whole chart (every team, every member) when the
 * caller is the dashboard owner. `assignableRoles` lists which roles the
 * caller may create/assign (server/org.js's ASSIGNABLE_ROLES) — the client
 * should read this instead of hardcoding a role list, so a Lead never even
 * sees "Team Lead" as an option to assign to someone else. */
export interface OrgResponse {
  teams: OrgTeam[];
  members: OrgMember[];
  selfMemberId: string | null;
  isOwner: boolean;
  assignableRoles: Exclude<Role, null>[];
  /** False when this project has no wiki to save the chart to — every edit
   * would fail with WIKI_MISSING, so the modal says so up front. */
  wikiAvailable?: boolean | null;
}

export interface Dashboard {
  org: string;
  project: string;
  person: Person;
  isSelf: boolean;
  visibleStates: string[];
  summary: Summary;
  stories: Story[];
  groups: IterationGroup[];
  recentItems: RecentItem[];
  prRepos: PrRepoSummary[];
  timeline: Timeline;
  blockedSignal: BlockedSignal;
  syncedAt: string;
  /** True while this payload is the fast first pass (last 14 days) of a
   * cold sync — today/this-week hours are exact, but total hours and the
   * work-item lists are still incomplete until the full pass replaces this.
   * See server/sync.js's two-phase `_runSync`. */
  partial: boolean;
  partialSince: string | null;
  /** True while a background pass is still attributing PRs to stories (see
   * server/sync.js's `_fillStoryPrs`) — `story.pullRequests` on every story/
   * unparented item may be stale (carried over from the previous sync)
   * until an SSE-triggered refetch clears this. */
  prsPending: boolean;
  /** 006-linked-identity-aliases (FR-009): describes whichever person THIS
   * dashboard is for — a teammate's dashboard (Team page) carries the
   * TEAMMATE's linked identities, not the viewer's. Always an array. */
  linkedIdentities: LinkedIdentity[];
  /** See PeopleResponse.self.identitiesDegraded. */
  identitiesDegraded: boolean;
}

export type SyncPhase = 'shared' | 'query' | 'hydrate' | 'prs' | 'history' | 'assemble';

/** GET /api/sync/progress — polled while a sync is in flight for a person.
 * `pct` is a weighted estimate, monotonic across the whole sync (including
 * across the partial-then-full two-phase driver). */
export interface SyncProgress {
  phase: SyncPhase;
  label: string;
  pct: number;
  partial: boolean;
  startedAt: number;
  updatedAt: number;
}

/** GET /api/scrum/* — the shared response envelope every Scrum route uses
 * (contracts/scrum-api.md). `computing: true` with `data: null` is distinct
 * from "this sprint has no data" — the two must never be rendered the same. */
export interface ScrumEnvelope<T> {
  computedAt: string;
  stale: boolean;
  computing: boolean;
  data: T | null;
}

export interface ScrumSprint {
  id: string | number | null;
  name: string;
  path: string;
  startDate: string;
  finishDate: string;
  status: 'past' | 'current' | 'future';
  datesKnown: boolean;
}

export interface ScrumSprintsData {
  sprints: ScrumSprint[];
  currentPath: string | null;
  excludedNoDates: number;
}

export interface SprintShare {
  storyId: number;
  storyTitle: string;
  sprintPath: string;
  basis: 'measured' | 'whole-credit';
  fraction: number | null;
  points: number;
  estimateAtSprintEnd: number | null;
  capped: boolean;
  remainder: boolean;
  overDistributedBy: number | null;
}

export interface SprintVelocity {
  sprintPath: string;
  total: number;
  completedPortion: number;
  partialPortion: number;
  measuredPortion: number;
  wholeCreditPortion: number;
  isProvisional: boolean;
  cappedStoryIds: number[];
  overDistributedStoryIds: number[];
  offRoster: { personKey: string; displayName: string }[];
  shares: SprintShare[];
  exclusions: { noEstimate: number; noMeasurableWork: number };
  unit: string;
}

export interface VelocityData {
  unit: string | null;
  unitAvailable: boolean;
  windowSize: number;
  sprints: SprintVelocity[];
  average: number | null;
  averageIsContextOnly: true;
}

// --- US2: sprint progress --------------------------------------------------

export interface StoryProgress {
  id: number;
  title: string;
  type: string;
  state: string;
  stateCategory: string | null;
  assignedTo: { displayName: string | null; uniqueName: string | null } | null;
  progress: number;
  progressBasis: 'hours' | 'stage';
  url: string;
}

export interface SprintProgressData {
  stories: StoryProgress[];
  counts: { completed: number; inProgress: number; notStarted: number };
}

// --- US3: utilisation -------------------------------------------------------

export interface CapacityAllocation {
  teamId: string;
  teamName: string;
  personKey: string;
  displayName: string;
  hours: number;
}

export interface AvailableTime {
  status: 'known' | 'not-recorded' | 'not-additive';
  hours: number | null;
  allocations: CapacityAllocation[];
  conflicts: CapacityAllocation[];
}

export interface MemberUtilisation {
  personKey: string;
  displayName: string;
  loggedHours: number;
  available: AvailableTime;
  utilisation: number | null;
  band: 'over' | 'normal' | 'under' | null;
}

export interface UtilisationData {
  members: MemberUtilisation[];
  summary: { membersWithKnownAvailability: number; membersExcluded: number };
  allUnknown: boolean;
  offRoster: { personKey: string; displayName: string; loggedHours: number }[];
}

// --- US4: burndown -----------------------------------------------------------

export interface BurndownPoint {
  date: string;
  remaining: number | null;
  ideal: number;
}

export interface BurndownData {
  points: BurndownPoint[];
  tracked: boolean;
  todayIndex: number;
}

// --- US5: impediments + blocked convention ------------------------------------

export interface Impediment {
  id: number;
  title: string;
  type: string;
  assignedTo: { displayName: string | null; uniqueName: string | null } | null;
  url: string;
  condition: 'blocked' | 'stalled';
  matchedOn: 'state' | 'tag' | 'field' | null;
  since: string | null;
  durationKnown: boolean;
  workingDays: number | null;
}

export interface ImpedimentsData {
  items: Impediment[];
  conventionConfigured: boolean;
  missingConfigRefs: string[];
}

export interface BlockedConventionRule {
  states: string[];
  tags: string[];
  field: string | null;
  /** A14: the exact value `field` must equal to mean "blocked" — matched by
   * equality, never truthiness. Required whenever `field` is set; absent on
   * a rule saved before this key existed (read server-side as boolean
   * `true`, matchBlocked's own default). */
  fieldBlockedValue?: string | boolean;
}

export interface BlockedConvention {
  version: 1;
  byType: Record<string, BlockedConventionRule>;
}

export interface WorkItemStateOption {
  name: string;
  category: string;
  color: string | null;
}

export interface BlockedConventionOptions {
  types: string[];
  statesByType: Record<string, WorkItemStateOption[]>;
  tags: string[];
  fields: string[];
}

export interface BlockedConventionData {
  convention: BlockedConvention;
  configured: boolean;
  canEdit: boolean;
  options: BlockedConventionOptions;
  suggestion: { byType: Record<string, BlockedConventionRule>; source: 'detector' } | null;
}

// --- US6: scope change --------------------------------------------------------

export interface ScopeChangeEvent {
  storyId: number;
  title: string;
  date: string;
  kind: 'added' | 'departed' | 're-estimated';
  departureKind: 'moved' | 'removed' | null;
  previousEstimate: number | null;
  newEstimate: number | null;
  contribution: number;
}

export interface ScopeChangeData {
  determinable: boolean;
  baselineDate: string | null;
  sizeAtStart: number;
  sizeAtEnd: number;
  net: number;
  endIsProvisional: boolean;
  unestimatedCount: number;
  events: ScopeChangeEvent[];
}
