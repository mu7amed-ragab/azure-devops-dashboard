import { Navigate, useSearchParams } from 'react-router-dom';
import { useDashboard } from '../../lib/useDashboard';
import { useMe } from '../../lib/useMe';
import { useTranslation } from '../../lib/i18n';
import { PullRequestsView } from '../../components/PullRequestsView';
import { LoadingView, ErrorView } from '../../components/StatusView';

export function PullRequestsPage() {
  const t = useTranslation();
  const { canSeePullRequests, isLoading: meLoading } = useMe();
  const { data, isLoading, isError, refetch } = useDashboard();
  const [searchParams, setSearchParams] = useSearchParams();
  const statusView = searchParams.get('status');

  // A role that hasn't loaded yet must not be treated as "no access" — that
  // would flash-redirect every visitor away before /api/people even answers.
  if (meLoading) return <LoadingView label={t('pr.loading')} />;
  if (!canSeePullRequests) return <Navigate to="/" replace />;

  if (isLoading && !data) return <LoadingView label={t('pr.syncingLabel')} />;
  if (isError && !data) return <ErrorView message={t('pr.couldNotLoad')} onRetry={() => refetch()} />;
  if (!data) return null;

  return (
    <div className="space-y-4 pb-16">
      <h1 className="text-lg font-semibold tracking-tight text-ink">{t('pr.heading')}</h1>

      <PullRequestsView
        personId={null}
        org={data.org}
        project={data.project}
        prRepos={data.prRepos}
        isSelf={data.isSelf}
        personDisplayName={data.person.displayName}
        forcedStatus={statusView}
        onClearForcedStatus={() => setSearchParams({})}
      />
    </div>
  );
}
