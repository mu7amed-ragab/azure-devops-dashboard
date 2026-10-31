import { Navigate } from 'react-router-dom';
import { useMe } from '../../lib/useMe';
import { useScrumVelocity, useScrumSprints } from '../../lib/useScrum';
import { usePersistedState } from '../../lib/persistedState';
import { LoadingView } from '../../components/StatusView';
import { useTranslation } from '../../lib/i18n';
import { roleLabel } from '../team/manage/roleRules';
import { VelocityCard } from './VelocityCard';
import { SprintProgressCard } from './SprintProgressCard';
import { UtilisationCard } from './UtilisationCard';
import { BurndownCard } from './BurndownCard';
import { ImpedimentsCard } from './ImpedimentsCard';
import { ScopeChangeCard } from './ScopeChangeCard';

const WINDOW_OPTIONS = [4, 6, 8, 12];
const DEFAULT_WINDOW = 6;

function sprintLabel(path: string): string {
  const parts = path.split('\\');
  return parts[parts.length - 1] || path;
}

/**
 * The Scrum page shell (FR-001). Velocity (US1) spans the whole window and
 * needs no single-sprint selection; every other view (US2–US6) is bound to
 * the ONE shared sprint selector below, so two cards can never describe two
 * different sprints (FR-003, SC-010).
 */
export function ScrumPage() {
  const t = useTranslation();
  const { role, isLoading: roleLoading, canSeeTeamPage } = useMe();
  // FR-003a: persisted per project via usePersistedState, so a window size
  // or sprint choice made in one project never leaks into another.
  const [windowSize, setWindowSize] = usePersistedState('scrum:window-size', DEFAULT_WINDOW);
  const [sprintPath, setSprintPath] = usePersistedState<string | null>('scrum:sprint', null);
  const velocity = useScrumVelocity(windowSize);
  const sprints = useScrumSprints();

  // A role that hasn't loaded yet must not be treated as "no role" — see
  // TeamPage's identical guard.
  if (roleLoading) return <LoadingView label={t('common.loading')} />;
  if (!canSeeTeamPage) return <Navigate to="/" replace />;

  const sprintList = sprints.data?.data?.sprints ?? [];
  const currentPath = sprints.data?.data?.currentPath ?? null;
  // FR-003: default to the sprint containing today; a persisted choice from
  // a PREVIOUS project (a stale path this project doesn't have) falls back
  // to current rather than silently selecting nothing.
  const effectiveSprintPath = sprintPath && sprintList.some((s) => s.path === sprintPath) ? sprintPath : currentPath;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">{t('scrum.heading')}</h1>
          {role && <p className="text-xs text-ink-muted">{t('scrum.signedInAs', { role: roleLabel(role) })}</p>}
        </div>
        <div className="flex items-center gap-3">
          {sprintList.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              {t('scrum.sprintLabel')}
              <select
                value={effectiveSprintPath ?? ''}
                onChange={(e) => setSprintPath(e.target.value || null)}
                className="focus-ring rounded-md border border-border bg-surface-sunken px-2 py-1 text-xs text-ink"
              >
                {/* With no effectiveSprintPath, this is the only <option> whose
                    value matches the select's own value ('') — without it the
                    browser falls back to visually selecting the first real
                    sprint below, even though no card is actually bound to it
                    (every card below reads effectiveSprintPath, which is
                    null). */}
                {!effectiveSprintPath && <option value="">{t('scrum.noSprintSelected')}</option>}
                {sprintList.map((s) => (
                  // dir="auto"/lang="en" applied directly rather than via
                  // <Foreign> (FR-021): <option> can only contain text, not
                  // the <span> Foreign renders by default, and HTML allows
                  // dir/lang as plain attributes on <option> itself.
                  <option key={s.path} value={s.path} dir="auto" lang="en">
                    {sprintLabel(s.path)} {s.status === 'current' ? t('scrum.currentSuffix') : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            {t('scrum.windowLabel')}
            <select
              value={windowSize}
              onChange={(e) => setWindowSize(Number(e.target.value))}
              className="focus-ring rounded-md border border-border bg-surface-sunken px-2 py-1 text-xs text-ink"
            >
              {WINDOW_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {t('scrum.sprintsCount', { count: n })}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {sprints.data && sprintList.length === 0 && (
        <section className="rounded-card border border-dashed border-border p-6 text-center text-sm text-ink-subtle">
          {t('scrum.noSprintsDefined')}
        </section>
      )}

      {velocity.data?.computedAt && (
        <p className="text-[11px] text-ink-subtle">
          {t('scrum.lastRefreshed', {
            time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', numberingSystem: 'latn' }).format(
              new Date(velocity.data.computedAt)
            ),
          })}
          {velocity.data.stale ? t('scrum.refreshingSuffix') : ''}
        </p>
      )}

      <section className="rounded-card border border-border bg-surface-raised p-4">
        <VelocityCard windowSize={windowSize} />
      </section>

      {sprintList.length > 0 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="rounded-card border border-border bg-surface-raised p-4">
            <SprintProgressCard sprintPath={effectiveSprintPath} />
          </section>
          <section className="rounded-card border border-border bg-surface-raised p-4">
            <UtilisationCard sprintPath={effectiveSprintPath} />
          </section>
          <section className="rounded-card border border-border bg-surface-raised p-4">
            <BurndownCard sprintPath={effectiveSprintPath} />
          </section>
          <section className="rounded-card border border-border bg-surface-raised p-4">
            <ImpedimentsCard sprintPath={effectiveSprintPath} />
          </section>
          <section className="rounded-card border border-border bg-surface-raised p-4 lg:col-span-2">
            <ScopeChangeCard sprintPath={effectiveSprintPath} />
          </section>
        </div>
      )}
    </div>
  );
}
