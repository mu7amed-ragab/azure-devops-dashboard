import { LoadingView, ErrorView, EmptyView } from '../../components/StatusView';
import { useScrumUtilisation } from '../../lib/useScrum';
import { useTranslation } from '../../lib/i18n';
import { Foreign } from '../../components/ui/Foreign';
import { formatHours, formatNumber } from '../../lib/format';

export function UtilisationCard({ sprintPath }: { sprintPath: string | null }) {
  const t = useTranslation();
  const STATUS_LABEL: Record<string, string> = {
    known: t('scrum.statusKnown'),
    'not-recorded': t('scrum.statusNotRecorded'),
    'not-additive': t('scrum.statusConflicting'),
  };
  const { data: envelope, isLoading, isError, refetch } = useScrumUtilisation(sprintPath);

  if (isLoading) return <LoadingView label={t('scrum.loadingUtilisation')} />;
  if (isError || !envelope) {
    return <ErrorView message={t('scrum.couldNotLoadUtilisation')} onRetry={() => refetch()} />;
  }

  const data = envelope.data;
  if (!data || data.members.length === 0) {
    return <EmptyView><p>{t('scrum.noRosterMembers')}</p></EmptyView>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{t('scrum.utilisation')}</h2>
        {data.summary.membersExcluded > 0 && (
          <span className="text-xs text-ink-muted">{t('scrum.membersExcluded', { count: data.summary.membersExcluded })}</span>
        )}
      </div>

      {data.allUnknown && (
        <EmptyView>
          <p>{t('scrum.allUnknownExplanation')}</p>
        </EmptyView>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] border-collapse text-xs">
          <thead>
            <tr className="text-start text-ink-subtle">
              <th className="pb-1 pe-2 font-medium">{t('scrum.personHeader')}</th>
              <th className="pb-1 pe-2 font-medium">{t('scrum.loggedHeader')}</th>
              <th className="pb-1 pe-2 font-medium">{t('scrum.availableHeader')}</th>
              <th className="pb-1 pe-2 font-medium" title={t('scrum.capacityUnitCaveat')}>{t('scrum.utilisation')}</th>
            </tr>
          </thead>
          <tbody>
            {data.members.map((m) => (
              <tr key={m.personKey} className="border-t border-border">
                <td className="py-1.5 pe-2 text-ink"><Foreign as="span">{m.displayName}</Foreign></td>
                <td className="py-1.5 pe-2 text-ink-muted">{formatHours(m.loggedHours)}</td>
                <td className="py-1.5 pe-2 text-ink-muted">
                  {m.available.status === 'known' ? (
                    <span title={m.available.allocations.map((a) => `${a.teamName}: ${formatHours(a.hours)}`).join(', ')}>
                      {t('scrum.availableTeamsCount', { hours: formatNumber(m.available.hours ?? 0), count: m.available.allocations.length })}
                    </span>
                  ) : (
                    <span title={m.available.conflicts.map((c) => `${c.teamName}: ${formatHours(c.hours)}`).join(', ') || undefined}>
                      {STATUS_LABEL[m.available.status]}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pe-2 text-ink-muted">
                  {m.available.status === 'known' ? (
                    <span title={t('scrum.capacityUnitCaveat')}>
                      {formatHours(m.loggedHours)} / {formatHours(m.available.hours ?? 0)}
                    </span>
                  ) : (
                    <span className="text-ink-subtle">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.offRoster.length > 0 && (
        <p className="text-xs text-ink-muted">
          {t('scrum.offRosterLoggedTime', {
            count: data.offRoster.length,
            names: data.offRoster.map((p) => `${p.displayName} (${formatHours(p.loggedHours)})`).join(', '),
          })}
        </p>
      )}
    </div>
  );
}

