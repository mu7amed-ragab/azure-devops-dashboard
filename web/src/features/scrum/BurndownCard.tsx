import { LineChart } from '../../components/ui/LineChart';
import { LoadingView, ErrorView, EmptyView } from '../../components/StatusView';
import { useScrumBurndown } from '../../lib/useScrum';
import { useTranslation } from '../../lib/i18n';

export function BurndownCard({ sprintPath }: { sprintPath: string | null }) {
  const t = useTranslation();
  const { data: envelope, isLoading, isError, refetch } = useScrumBurndown(sprintPath);

  if (isLoading) return <LoadingView label={t('scrum.loadingBurndown')} />;
  if (isError || !envelope) {
    return <ErrorView message={t('scrum.couldNotLoadBurndown')} onRetry={() => refetch()} />;
  }

  const data = envelope.data;
  if (!data || !data.tracked) {
    return (
      <EmptyView>
        <p>{t('scrum.remainingWorkNotTracked')}</p>
      </EmptyView>
    );
  }

  const points = data.points.map((p) => ({
    label: p.date.slice(5), // MM-DD — the year is redundant within one sprint
    actual: p.remaining,
    ideal: p.ideal,
  }));

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-ink">{t('scrum.burndown')}</h2>
      <LineChart points={points} />
    </div>
  );
}
