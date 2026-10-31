import { StateChip } from '../../components/StateChip';
import { Pill } from '../../components/ui/Pill';
import { LoadingView, ErrorView, EmptyView } from '../../components/StatusView';
import { useScrumProgress } from '../../lib/useScrum';
import { useTranslation } from '../../lib/i18n';
import { Foreign } from '../../components/ui/Foreign';

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function SprintProgressCard({ sprintPath }: { sprintPath: string | null }) {
  const t = useTranslation();
  const { data: envelope, isLoading, isError, refetch } = useScrumProgress(sprintPath);

  if (isLoading) return <LoadingView label={t('scrum.loadingSprintProgress')} />;
  if (isError || !envelope) {
    return <ErrorView message={t('scrum.couldNotLoadSprintProgress')} onRetry={() => refetch()} />;
  }

  const data = envelope.data;
  if (!data || data.stories.length === 0) {
    return <EmptyView><p>{t('scrum.noStoriesInSprint')}</p></EmptyView>;
  }

  const { counts, stories } = data;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{t('scrum.sprintProgressHeading')}</h2>
        <span className="text-xs text-ink-muted">
          {t('scrum.progressSummary', { completed: counts.completed, inProgress: counts.inProgress, notStarted: counts.notStarted })}
        </span>
      </div>

      <div className="max-h-96 space-y-1.5 overflow-y-auto">
        {stories.map((s) => (
          <a
            key={s.id}
            href={s.url}
            target="_blank"
            rel="noreferrer"
            className="focus-ring flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 text-xs hover:border-accent/50"
          >
            <Foreign as="span" className="min-w-0 flex-1 truncate text-ink">{s.title}</Foreign>
            {s.assignedTo?.displayName && <Foreign as="span" className="shrink-0 text-ink-subtle">{s.assignedTo.displayName}</Foreign>}
            <StateChip state={s.state} />
            <span className="flex shrink-0 items-center gap-1">
              {/* FR-016a/SC-016: a stage-derived figure must not look like a
                  measurement — shown as a Pill labelled "inferred" instead of
                  a bare number in the progress bar's own tone. */}
              <div
                className="h-1.5 w-16 overflow-hidden rounded-full bg-ink/10"
                title={t('scrum.progressTitle', {
                  pct: pct(s.progress),
                  basis: s.progressBasis === 'hours' ? t('scrum.progressMeasured') : t('scrum.progressInferredFromStage'),
                })}
              >
                <div
                  className={`h-full ${s.progressBasis === 'hours' ? 'bg-accent' : 'bg-ink-muted'}`}
                  style={{ width: pct(s.progress) }}
                />
              </div>
              <span className="w-9 text-end text-ink-muted">{pct(s.progress)}</span>
              {s.progressBasis === 'stage' && (
                <Pill tone="neutral" className="text-[9px]">{t('scrum.inferredPill')}</Pill>
              )}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
