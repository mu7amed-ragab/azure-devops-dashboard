import { useEffect, useState } from 'react';
import { Clock, GitPullRequest, ListTodo, Ban, ChevronDown, Link2 } from 'lucide-react';
import { useDashboard } from '../lib/useDashboard';
import { useMe } from '../lib/useMe';
import { StatTile } from './StatTile';
import { HoursStrip } from './HoursStrip';
import { WorkItemsView } from './WorkItemsView';
import { PullRequestsView } from './PullRequestsView';
import { ErrorView } from './StatusView';
import { SyncProgressNotice } from './SyncProgressNotice';
import { Tabs } from './ui/Tabs';
import { Foreign } from './ui/Foreign';
import { formatRelative } from '../lib/format';
import { useLang } from '../lib/i18n/useLang';
import { useTranslation } from '../lib/i18n';
import { usePersistedState } from '../lib/persistedState';
import { countFor, type ViewId } from '../lib/workItemViews';
import { linkedDomains } from '../lib/linkedDomains';
import type { Person } from '../lib/types';

interface TeamMemberSectionProps {
  person: Person;
  defaultOpen?: boolean;
  /** Team-wide "Expand all"/"Collapse all" — toggles member sections only;
   * each member keeps its own inner expand/collapse (see WorkItemsView). */
  expandSignal?: number;
  collapseSignal?: number;
}

type Tab = 'work-items' | 'pull-requests';

/** One collapsible section of the Team page: a teammate's own mini-
 * dashboard (hours strip + stat tiles) plus tabs for their Work Items and
 * Pull Requests, mounted independently via `useDashboard(person.id)` so
 * several sections can be open at once without interfering with each
 * other's filters. */
export function TeamMemberSection({ person, defaultOpen, expandSignal, collapseSignal }: TeamMemberSectionProps) {
  useLang((s) => s.lang); // subscribe so formatRelative() below re-renders on language switch
  const t = useTranslation();
  const { canSeePullRequests } = useMe();
  const [open, setOpen] = usePersistedState(`team:section:${person.id}`, !!defaultOpen);
  useEffect(() => { if (expandSignal) setOpen(true); }, [expandSignal]);
  useEffect(() => { if (collapseSignal) setOpen(false); }, [collapseSignal]);
  const { data, isLoading, isError, error, refetch } = useDashboard(person.id);
  const linkedDomainList = data ? linkedDomains(data.linkedIdentities) : [];
  const [tab, setTab] = usePersistedState<Tab>(`team:section:${person.id}:tab`, 'work-items');
  const [view, setView] = useState<ViewId | null>(null);
  const [prStatus, setPrStatus] = useState<string | null>(null);

  function applyView(v: ViewId) {
    // Toggle: clicking the tile that's already applied clears it, matching
    // the accent highlight that shows it's the one currently in effect.
    setView((prev) => (prev === v ? null : v));
    setTab('work-items');
  }

  return (
    <div className="rounded-card border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex w-full cursor-pointer items-center justify-between gap-3 rounded-card px-4 py-3 text-start"
        aria-expanded={open}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ChevronDown size={16} className={`shrink-0 text-ink-subtle transition-transform ${open ? 'rotate-180' : ''}`} />
          <Foreign as="span" className="truncate text-sm font-semibold text-ink">{person.displayName}</Foreign>
          {/* 006-linked-identity-aliases (FR-009, US2): discloses THIS
              teammate's own linked identity, not the viewer's — data.
              linkedIdentities is always an array, so this renders nothing
              for the common single-identity member. A title attribute is
              enough here; the account menu (UserChip) has the full
              disclosure for the signed-in person's own case. */}
          {linkedDomainList.length > 0 && (
            <span
              className="shrink-0 text-ink-subtle"
              title={`${t('account.alsoIncludesDomain', { count: linkedDomainList.length })} ${linkedDomainList.join(', ')}`}
            >
              <Link2 size={12} aria-label={t('account.alsoIncludesDomain', { count: linkedDomainList.length })} />
            </span>
          )}
        </div>
        <span className="shrink-0 text-xs text-ink-subtle">
          {data ? t('team.memberSyncedRelative', { relative: formatRelative(data.syncedAt) }) : isLoading ? t('team.memberSyncing') : ''}
        </span>
      </button>

      {open && (
        <div className="space-y-4 border-t border-border p-4">
          {isLoading && !data && (
            <SyncProgressNotice personId={person.id} enabled fallbackLabel={t('team.memberSyncingDashboard', { name: person.displayName })} />
          )}
          {isError && !data && (
            <ErrorView
              message={
                error instanceof Error && error.message === 'SYNCING'
                  ? t('team.memberFirstSyncRunning')
                  : t('team.memberCouldNotLoad', { name: person.displayName })
              }
              onRetry={() => refetch()}
            />
          )}
          {data && (
            <>
              {data.partial && (
                <SyncProgressNotice
                  personId={person.id}
                  enabled
                  fallbackLabel={t('sync.partialFallback')}
                />
              )}

              <section className="flex snap-x gap-2 overflow-x-auto pb-1">
                <StatTile
                  label={t('dashboard.activeStories')}
                  value={countFor('active-stories', data)}
                  icon={<ListTodo size={14} />}
                  onClick={() => applyView('active-stories')}
                  active={view === 'active-stories'}
                  title={t('dashboard.activeStoriesTitle')}
                />
                <StatTile
                  label={t('dashboard.blockedStories')}
                  value={countFor('blocked-stories', data)}
                  icon={<Ban size={14} />}
                  tone={countFor('blocked-stories', data) > 0 ? 'danger' : 'default'}
                  onClick={() => applyView('blocked-stories')}
                  active={view === 'blocked-stories'}
                  title={t('dashboard.blockedStoriesTitle')}
                />
                <StatTile
                  label={t('dashboard.tasksInProgress')}
                  value={countFor('tasks-in-progress', data)}
                  icon={<Clock size={14} />}
                  onClick={() => applyView('tasks-in-progress')}
                  active={view === 'tasks-in-progress'}
                  title={t('dashboard.tasksInProgressTitle')}
                />
                <StatTile
                  label={t('dashboard.blockedTasks')}
                  value={countFor('blocked', data)}
                  icon={<Ban size={14} />}
                  tone={countFor('blocked', data) > 0 ? 'danger' : 'default'}
                  onClick={() => applyView('blocked')}
                  active={view === 'blocked'}
                  title={t('dashboard.blockedTasksTitle')}
                />
                {canSeePullRequests && (
                  <StatTile
                    label={t('dashboard.openPullRequests')}
                    value={data.summary.openPullRequests}
                    icon={<GitPullRequest size={14} />}
                    onClick={() => {
                      setPrStatus((prev) => (prev === 'active' ? null : 'active'));
                      setTab('pull-requests');
                    }}
                    active={tab === 'pull-requests' && prStatus === 'active'}
                    title={t('team.openPullRequestsTitle')}
                  />
                )}
              </section>

              <HoursStrip
                timeline={data.timeline}
                org={data.org}
                project={data.project}
                crossProject
                personId={person.id}
                personName={person.displayName}
              />

              {canSeePullRequests && (
                <Tabs
                  aria-label={t('team.memberWorkAriaLabel', { name: person.displayName })}
                  value={tab}
                  onChange={setTab}
                  options={[
                    { id: 'work-items', label: t('nav.workitems'), icon: ListTodo },
                    { id: 'pull-requests', label: t('nav.pullrequests'), icon: GitPullRequest },
                  ]}
                />
              )}

              {tab === 'work-items' || !canSeePullRequests ? (
                <WorkItemsView
                  data={data}
                  isLoading={isLoading}
                  isError={isError}
                  refetch={refetch}
                  showHeading={false}
                  scope={person.id}
                  view={view}
                  onViewChange={setView}
                />
              ) : (
                <PullRequestsView
                  personId={person.id}
                  org={data.org}
                  project={data.project}
                  prRepos={data.prRepos}
                  isSelf={data.isSelf}
                  personDisplayName={person.displayName}
                  forcedStatus={prStatus}
                  onClearForcedStatus={() => setPrStatus(null)}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
