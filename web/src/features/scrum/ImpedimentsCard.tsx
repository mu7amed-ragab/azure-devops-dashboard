import { useState } from 'react';
import { Pill } from '../../components/ui/Pill';
import { LoadingView, ErrorView, EmptyView } from '../../components/StatusView';
import { useScrumImpediments } from '../../lib/useScrum';
import { BlockedConventionEditor } from './BlockedConventionEditor';
import { useTranslation } from '../../lib/i18n';
import { Foreign } from '../../components/ui/Foreign';

export function ImpedimentsCard({ sprintPath }: { sprintPath: string | null }) {
  const t = useTranslation();
  const { data: envelope, isLoading, isError, refetch } = useScrumImpediments(sprintPath);
  const [editing, setEditing] = useState(false);

  if (isLoading) return <LoadingView label={t('scrum.loadingImpediments')} />;
  if (isError || !envelope) {
    return <ErrorView message={t('scrum.couldNotLoadImpediments')} onRetry={() => refetch()} />;
  }

  const data = envelope.data;
  const CONDITION_LABEL: Record<string, string> = {
    blocked: t('scrum.impedimentsBlocked'),
    stalled: t('scrum.impedimentsStalled'),
  };

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{t('scrum.blockedStalledHeading')}</h2>
        <button type="button" onClick={() => setEditing((v) => !v)} className="focus-ring rounded-md text-xs text-accent hover:underline">
          {editing ? t('common.close') : t('scrum.conventionEllipsis')}
        </button>
      </div>

      {editing && <BlockedConventionEditor sprintPath={sprintPath} onClose={() => setEditing(false)} />}

      {!data ? null : !data.conventionConfigured ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-ink-muted">
          {t('scrum.noConventionSet')}{' '}
          <button type="button" onClick={() => setEditing(true)} className="focus-ring text-accent hover:underline">
            {t('scrum.setItUp')}
          </button>
          .
        </p>
      ) : null}

      {data && data.missingConfigRefs.length > 0 && (
        <p className="text-xs text-warning">
          {t('scrum.conventionNamesMissing', { refs: data.missingConfigRefs.join(', ') })}
        </p>
      )}

      {!data || data.items.length === 0 ? (
        <EmptyView><p>{t('scrum.nothingBlockedNow')}</p></EmptyView>
      ) : (
        <div className="max-h-96 space-y-1.5 overflow-y-auto">
          {data.items.map((item) => (
            <a
              key={item.id}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="focus-ring flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 text-xs hover:border-accent/50"
            >
              <Pill tone={item.condition === 'blocked' ? 'danger' : 'warning'}>{CONDITION_LABEL[item.condition] ?? item.condition}</Pill>
              <Foreign as="span" className="min-w-0 flex-1 truncate text-ink">{item.title}</Foreign>
              {item.assignedTo?.displayName && <Foreign as="span" className="shrink-0 text-ink-subtle">{item.assignedTo.displayName}</Foreign>}
              <span className="shrink-0 text-ink-muted">
                {item.durationKnown ? t('scrum.workingDaysCount', { count: item.workingDays ?? 0 }) : t('scrum.durationUndeterminable')}
              </span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
