import { Link } from 'react-router-dom';
import { Clock, GitPullRequest, ListTodo, Ban } from 'lucide-react';
import { useDashboard } from '../../lib/useDashboard';
import { useMe } from '../../lib/useMe';
import { useTranslation } from '../../lib/i18n';
import { StatTile } from '../../components/StatTile';
import { HoursStrip } from '../../components/HoursStrip';
import { WorkItemsView } from '../../components/WorkItemsView';
import { DashboardSkeleton, ErrorView, EmptyView } from '../../components/StatusView';
import { SyncProgressNotice } from '../../components/SyncProgressNotice';
import { countFor } from '../../lib/workItemViews';

export function DashboardPage() {
  const t = useTranslation();
  const { data, isLoading, isError, error, refetch } = useDashboard();
  const { canSeePullRequests } = useMe();

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <SyncProgressNotice personId={null} enabled fallbackLabel={t('sync.firstRunFallback')} />
        <DashboardSkeleton label={t('sync.firstRunFallback')} />
      </div>
    );
  }
  if (isError && !data) {
    const msg = error instanceof Error && error.message === 'SYNCING'
      ? t('status.firstSyncRunning')
      : t('status.couldNotReach');
    return <ErrorView message={msg} onRetry={() => refetch()} />;
  }
  if (!data) return null;

  const { summary } = data;
  const activeStories = countFor('active-stories', data);
  const blockedStories = countFor('blocked-stories', data);
  const tasksInProgress = countFor('tasks-in-progress', data);
  const blockedTasks = countFor('blocked', data);

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold tracking-tight text-ink">{t('dashboard.heading')}</h1>

      {data.partial && (
        <SyncProgressNotice personId={null} enabled fallbackLabel={t('sync.partialFallback')} />
      )}

      <section className="flex snap-x gap-2 overflow-x-auto pb-1">
        <StatTile
          label={t('dashboard.activeStories')}
          value={activeStories}
          icon={<ListTodo size={14} />}
          to="/work-items?view=active-stories"
          title={t('dashboard.activeStoriesTitle')}
        />
        <StatTile
          label={t('dashboard.blockedStories')}
          value={blockedStories}
          icon={<Ban size={14} />}
          tone={blockedStories > 0 ? 'danger' : 'default'}
          to="/work-items?view=blocked-stories"
          title={t('dashboard.blockedStoriesTitle')}
        />
        <StatTile
          label={t('dashboard.tasksInProgress')}
          value={tasksInProgress}
          icon={<Clock size={14} />}
          to="/work-items?view=tasks-in-progress"
          title={t('dashboard.tasksInProgressTitle')}
        />
        <StatTile
          label={t('dashboard.blockedTasks')}
          value={blockedTasks}
          icon={<Ban size={14} />}
          tone={blockedTasks > 0 ? 'danger' : 'default'}
          to="/work-items?view=blocked"
          title={t('dashboard.blockedTasksTitle')}
        />
        {canSeePullRequests && (
          <StatTile
            label={t('dashboard.openPullRequests')}
            value={summary.openPullRequests}
            icon={<GitPullRequest size={14} />}
            to="/pull-requests?status=active"
            title={t('dashboard.openPullRequestsTitle')}
          />
        )}
      </section>

      {/* No personId: this is the caller's own card. The Team page passes the
          teammate's id to the same component — see HoursStrip. */}
      <HoursStrip timeline={data.timeline} org={data.org} project={data.project} crossProject />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">{t('dashboard.recentlyUpdated')}</h2>

        {data.recentItems.length === 0 ? (
          <EmptyView>{t('dashboard.lastThirtyDays')}</EmptyView>
        ) : (
          <WorkItemsView
            data={data}
            isLoading={isLoading}
            isError={isError}
            refetch={refetch}
            showHeading={false}
            scope="recent"
            source="recent"
          />
        )}
        <Link to="/work-items" className="focus-ring inline-block text-xs font-medium text-accent hover:underline">
          {t('dashboard.viewAll')}
        </Link>
      </section>
    </div>
  );
}
