import { Pill, type PillTone } from '../../components/ui/Pill';
import { LoadingView, ErrorView, EmptyView } from '../../components/StatusView';
import { useScrumScopeChange } from '../../lib/useScrum';
import { useTranslation } from '../../lib/i18n';
import { Foreign } from '../../components/ui/Foreign';

const KIND_TONE: Record<string, PillTone> = { added: 'success', departed: 'danger', 're-estimated': 'warning' };

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function ScopeChangeCard({ sprintPath }: { sprintPath: string | null }) {
  const t = useTranslation();
  const KIND_LABEL: Record<string, string> = {
    added: t('scrum.scopeAdded'),
    departed: t('scrum.scopeDeparted'),
    're-estimated': t('scrum.scopeReestimated'),
  };
  const { data: envelope, isLoading, isError, refetch } = useScrumScopeChange(sprintPath);

  if (isLoading) return <LoadingView label={t('scrum.loadingScopeChange')} />;
  if (isError || !envelope) {
    return <ErrorView message={t('scrum.couldNotLoadScopeChange')} onRetry={() => refetch()} />;
  }

  const data = envelope.data;
  if (!data || !data.determinable) {
    return (
      <EmptyView>
        <p>{t('scrum.scopeUndeterminable')}</p>
      </EmptyView>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{t('scrum.scopeChange')}</h2>
        <span dir="ltr" className="text-xs text-ink-muted">
          {t('scrum.scopeSizeSummary', {
            start: data.sizeAtStart,
            end: data.sizeAtEnd,
            soFar: data.endIsProvisional ? t('scrum.soFarSuffix') : '',
            signed: signed(data.net),
          })}
        </span>
      </div>

      <p className="text-[11px] text-ink-subtle">{t('scrum.scopeBaseline', { date: data.baselineDate ?? '' })}</p>

      {data.unestimatedCount > 0 && (
        <p className="text-xs text-ink-muted">{t('scrum.unestimatedExcluded', { count: data.unestimatedCount })}</p>
      )}

      {data.events.length === 0 ? (
        <EmptyView><p>{t('scrum.scopeStable')}</p></EmptyView>
      ) : (
        <div className="max-h-96 space-y-1.5 overflow-y-auto">
          {data.events.map((e, i) => (
            <div key={`${e.storyId}-${i}`} className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 text-xs">
              <Pill tone={KIND_TONE[e.kind]}>{e.kind === 'departed' && e.departureKind ? `${KIND_LABEL[e.kind]} (${e.departureKind})` : KIND_LABEL[e.kind]}</Pill>
              <Foreign as="span" className="min-w-0 flex-1 truncate text-ink">{e.title}</Foreign>
              <span className="shrink-0 text-ink-subtle">{e.date.slice(0, 10)}</span>
              <span className="w-12 shrink-0 text-end text-ink-muted" dir="ltr">{signed(e.contribution)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
