import { AlertTriangle } from 'lucide-react';
import { BarChart } from '../../components/ui/BarChart';
import { LoadingView, ErrorView, EmptyView } from '../../components/StatusView';
import { useScrumVelocity } from '../../lib/useScrum';
import { useTranslation } from '../../lib/i18n';

const MIN_SPRINTS_FOR_AVERAGE = 2;

function sprintLabel(path: string): string {
  // "ProjectA\Sprint 78" -> "Sprint 78" — the last path segment is what a
  // reader actually scans for; the project prefix is redundant on a
  // single-project page.
  const parts = path.split('\\');
  return parts[parts.length - 1] || path;
}

export function VelocityCard({ windowSize }: { windowSize: number }) {
  const t = useTranslation();
  const { data: envelope, isLoading, isError, refetch } = useScrumVelocity(windowSize);

  if (isLoading) return <LoadingView label={t('scrum.loadingVelocity')} />;
  if (isError || !envelope) {
    return <ErrorView message={t('scrum.couldNotLoadVelocity')} onRetry={() => refetch()} />;
  }

  const data = envelope.data;
  if (!data || !data.unitAvailable) {
    return (
      <EmptyView>
        <p>{t('scrum.velocityUnavailable')}</p>
      </EmptyView>
    );
  }

  if (data.sprints.length < MIN_SPRINTS_FOR_AVERAGE) {
    return (
      <EmptyView>
        <p>{t('scrum.notEnoughSprintHistory', { count: MIN_SPRINTS_FOR_AVERAGE })}</p>
      </EmptyView>
    );
  }

  const series = data.sprints.map((s) => ({
    label: sprintLabel(s.sprintPath),
    value: s.total,
    secondaryValue: s.completedPortion,
    muted: s.isProvisional,
  }));

  const disclosedStories = data.sprints.flatMap((s) => [
    ...s.cappedStoryIds.map((id) => ({ id, sprintPath: s.sprintPath, kind: 'capped' as const })),
    ...s.overDistributedStoryIds.map((id) => ({ id, sprintPath: s.sprintPath, kind: 'over' as const })),
  ]);
  const offRosterCount = data.sprints.reduce((acc, s) => acc + s.offRoster.length, 0);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{t('scrum.velocity')}</h2>
        <span className="text-xs text-ink-muted">{data.unit}</span>
      </div>

      <BarChart series={series} reference={data.average} referenceLabel={t('scrum.velocityAverage')} />

      {/* FR-009a: completed vs partial is shown via the two-tone bar above;
          this line spells it out for anyone reading via a screen reader. */}
      <p className="text-[11px] text-ink-subtle">{t('scrum.velocityLegend')}</p>

      {/* FR-011a–d: the average is historical context only, never a
          commitment, target, or forecast — this framing is mandatory, not
          decorative. */}
      <p className="text-xs text-ink-muted">{t('scrum.velocityAverageContext')}</p>

      {disclosedStories.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            {disclosedStories.filter((d) => d.kind === 'capped').length > 0 &&
              t('scrum.storiesCappedWarning', { count: disclosedStories.filter((d) => d.kind === 'capped').length })}
            {disclosedStories.filter((d) => d.kind === 'over').length > 0 && t('scrum.overDistributedWarning')}
          </span>
        </p>
      )}

      {offRosterCount > 0 && (
        <p className="text-xs text-ink-muted">{t('scrum.offRosterContributions', { count: offRosterCount })}</p>
      )}
    </div>
  );
}
