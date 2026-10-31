import { useState } from 'react';
import { Layers, User, X } from 'lucide-react';
import type { CrossHoursResponse, Timeline } from '../lib/types';
import { formatDate, formatHours } from '../lib/format';
import { useLang } from '../lib/i18n/useLang';
import { t } from '../lib/i18n';
import { workItemUrl } from '../lib/adoLinks';
import { typeTheme } from '../lib/typeTheme';
import { useCrossHours } from '../lib/useCrossHours';
import { usePersistedState } from '../lib/persistedState';
import { Tabs } from './ui/Tabs';
import { Pill } from './ui/Pill';
import { InlineMessage } from './ui/InlineMessage';
import { Foreign } from './ui/Foreign';

const WEEKDAY_FORMAT = new Intl.DateTimeFormat('en', { weekday: 'short' });

/** Which series the card is showing. `cross` sums every project the person's
 * token can read — see server/crossHours.js. */
type HoursScope = 'project' | 'cross';

function dayLabel(dateStr: string): string {
  return WEEKDAY_FORMAT.format(new Date(`${dateStr}T00:00:00Z`));
}

function Figure({
  label,
  date,
  hours,
  emphasize,
  open,
  onClick,
}: {
  label: string;
  date: string;
  hours: number;
  emphasize?: boolean;
  open: boolean;
  onClick: () => void;
}) {
  useLang((s) => s.lang); // subscribe so formatDate() below re-renders on language switch
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={t('hours.figureAriaLabel', { label, hours })}
      className={`focus-ring flex cursor-pointer flex-col gap-0.5 rounded-md px-1.5 py-1 text-start transition-colors hover:bg-surface-sunken ${
        open ? 'ring-1 ring-accent' : ''
      }`}
    >
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      <span className={`text-2xl font-semibold tabular-nums ${emphasize ? 'text-accent' : 'text-ink'}`}>{formatHours(hours)}</span>
      <span className="text-xs text-ink-subtle">{formatDate(date)}</span>
    </button>
  );
}

function BreakdownPanel({ date, hours, org, project, entries, onClose }: {
  date: string;
  hours: number;
  org: string;
  /** The signed-in project — the fallback for an entry with no project of its
   * own (the per-project series), and what a cross-project entry is compared
   * against to decide whether naming its project tells the reader anything. */
  project: string;
  entries: Timeline['breakdown'][string];
  onClose: () => void;
}) {
  useLang((s) => s.lang); // subscribe so formatDate() below re-renders on language switch
  return (
    <div className="mt-4 space-y-2 rounded-card border border-border bg-surface-sunken p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink">
          {formatDate(date)} — {formatHours(hours)}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('dashboard.closeBreakdownAriaLabel')}
          className="focus-ring flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-ink-subtle transition-colors hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-ink-subtle">{t('hours.noneLoggedToday')}</p>
      ) : (
        <div className="space-y-1">
          {entries.map((entry) => {
            const theme = typeTheme(entry.type);
            // A cross-project row links into ITS OWN project, not the one the
            // session happens to be in — same reasoning as the PR page's
            // cross-project links (see server/ado/pullrequests.js).
            const itemProject = entry.project || project;
            return (
              <a
                key={`${itemProject}#${entry.id}`}
                href={workItemUrl(org, itemProject, entry.id)}
                target="_blank"
                rel="noreferrer"
                className="focus-ring flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-surface"
              >
                <Foreign
                  as="span"
                  knownLang="en"
                  className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${theme.tint} ${theme.border} border`}
                >
                  {entry.type}
                </Foreign>
                {/* text-start: this span is flex-1 (wider than its text), so
                 * without it dir="auto" flipping to RTL for an Arabic title
                 * would also flip text-align, floating the title to the
                 * right instead of leading the row like every other title
                 * on the row. knownLang omitted: a work item title is free
                 * text a person typed, not a known-English literal. */}
                <Foreign className="min-w-0 flex-1 truncate text-start text-ink">
                  {entry.title}
                </Foreign>
                {entry.project && (
                  <Pill tone="accent" className="max-w-[8rem]" title={entry.project}>
                    <Foreign as="span" className="truncate">{entry.project}</Foreign>
                  </Pill>
                )}
                <span className="shrink-0 tabular-nums text-ink-muted">{formatHours(entry.hours)}</span>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BuildingNotice({
  data,
  personName,
}: {
  data: Extract<CrossHoursResponse, { status: 'building' }>;
  /** Omitted on your own card, the teammate's display name on theirs. */
  personName?: string;
}) {
  const progress = data.progress;
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  const queued = !!(progress && progress.queued);
  return (
    <div className="mt-3 space-y-2 rounded-card border border-border bg-surface-sunken p-3">
      <p className="text-xs text-ink-muted">
        {queued ? (
          <>{personName ? t('hours.buildingQueuedPerson', { name: personName }) : t('hours.buildingQueuedSelf')}</>
        ) : (
          <>
            {personName ? t('hours.addingUpPerson', { name: personName }) : t('hours.addingUpSelf')}
            {progress && progress.total ? t('hours.progressCount', { done: progress.done, total: progress.total }) : ''}
            {progress && progress.project ? t('hours.progressReading', { project: progress.project }) : ''}…
          </>
        )}
      </p>
      <div className="h-1 w-full overflow-hidden rounded-full bg-surface">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${pct ?? 5}%` }}
        />
      </div>
      <p className="text-xs text-ink-subtle">{t('hours.crossFirstReadNotice')}</p>
    </div>
  );
}

export function HoursStrip({
  timeline,
  org,
  project,
  crossProject = false,
  personId,
  personName,
}: {
  timeline: Timeline;
  org: string;
  project: string;
  /** Offers the All projects tab. */
  crossProject?: boolean;
  /** Whose hours the All projects tab asks for — omitted on your own
   * dashboard, the teammate's id in a Team page section. The projects covered
   * are always the ones YOUR token can read (see server/crossHours.js), which
   * is why a teammate's card says so under the figures. */
  personId?: string | null;
  /** That teammate's display name, for the wording only. */
  personName?: string;
}) {
  useLang((s) => s.lang); // subscribe so formatDate() below re-renders on language switch
  const scopeTabs = [
    { id: 'project' as const, label: t('hours.scopeThisProject'), icon: User },
    { id: 'cross' as const, label: t('hours.scopeAllProjects'), icon: Layers },
  ];
  const [openDay, setOpenDay] = useState<string | null>(null);
  // Per person: each Team section remembers which tab it was left on, instead
  // of every open section flipping together with the Dashboard's card.
  const [scope, setScope] = usePersistedState<HoursScope>(
    personId ? `hours-scope:${personId}` : 'hours-scope',
    'project'
  );
  const showCross = crossProject && scope === 'cross';
  const cross = useCrossHours(showCross, personId);
  const crossReady = cross.data && cross.data.status === 'ready' ? cross.data : null;

  // Falls back to this project's series until the cross one exists, so the
  // card never renders an empty skeleton where numbers used to be — and the
  // heading below names what is ACTUALLY on screen, not which tab is
  // selected, so a building card never labels one project's hours as every
  // project's.
  const showingCross = showCross && crossReady !== null;
  const shown = showingCross ? crossReady.timeline : timeline;
  const maxHours = Math.max(1, ...shown.last7Days.map((d) => d.hours));

  function toggleDay(date: string) {
    setOpenDay((prev) => (prev === date ? null : date));
  }

  const openHours =
    openDay === shown.today.date
      ? shown.today.hours
      : shown.last7Days.find((d) => d.date === openDay)?.hours ?? 0;

  return (
    <section className="rounded-card border border-border bg-surface-raised p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{showingCross ? t('hours.crossProjectHeading') : t('hours.heading')}</h2>
        {crossProject && (
          <Tabs
            aria-label={t('dashboard.whichProjectsAriaLabel')}
            options={scopeTabs}
            value={scope}
            onChange={(next) => {
              setScope(next);
              // The open day belongs to the series it was opened from; the
              // other one's numbers for that date are a different answer.
              setOpenDay(null);
            }}
            centered={false}
          />
        )}
      </div>

      {showCross && cross.data && cross.data.status === 'building' && !crossReady && (
        <BuildingNotice data={cross.data} personName={personName} />
      )}
      {showCross && cross.isError && (
        <InlineMessage tone="error">
          {personName ? t('hours.crossErrorPerson', { name: personName }) : t('hours.crossErrorSelf')}
        </InlineMessage>
      )}

      <div className="mt-3 flex flex-wrap gap-6">
        <Figure
          label={t('hours.today')}
          date={shown.today.date}
          hours={shown.today.hours}
          emphasize
          open={openDay === shown.today.date}
          onClick={() => toggleDay(shown.today.date)}
        />
        <Figure
          label={t('hours.yesterday')}
          date={shown.yesterday.date}
          hours={shown.yesterday.hours}
          open={openDay === shown.yesterday.date}
          onClick={() => toggleDay(shown.yesterday.date)}
        />
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-ink-muted">{t('hours.thisWeek')}</span>
          <span className="text-2xl font-semibold tabular-nums text-ink">{formatHours(shown.thisWeek.hours)}</span>
          <span className="text-xs text-ink-subtle">{t('hours.weekOf', { date: formatDate(shown.thisWeek.period) })}</span>
        </div>
        {shown.weeklyAverage && (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-ink-muted">{t('hours.weeklyAverage')}</span>
            <span className="text-2xl font-semibold tabular-nums text-ink">{formatHours(shown.weeklyAverage.hoursPerDay)}</span>
            <span className="text-xs text-ink-subtle">
              {t('hours.weeklyUtilization', { pct: shown.weeklyAverage.utilizationPct })}
            </span>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-end gap-2">
        {shown.last7Days.map((d) => (
          <button
            key={d.date}
            type="button"
            onClick={() => toggleDay(d.date)}
            aria-expanded={openDay === d.date}
            aria-label={t('hours.dayAriaLabel', { day: dayLabel(d.date), date: formatDate(d.date), hours: d.hours })}
            className={`focus-ring flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-1 rounded-md py-1 transition-colors hover:bg-surface-sunken ${
              openDay === d.date ? 'ring-1 ring-accent' : ''
            }`}
          >
            <div className="flex h-16 w-full items-end">
              <div
                className="w-full rounded-t"
                style={{
                  height: `${Math.max(4, (d.hours / maxHours) * 100)}%`,
                  background: 'var(--chart-series-1)',
                  opacity: d.hours === 0 ? 0.25 : 1,
                }}
              />
            </div>
            <span className="whitespace-nowrap text-xs tabular-nums text-ink-subtle">{formatHours(d.hours)}</span>
            <span className="whitespace-nowrap text-xs text-ink-subtle">{dayLabel(d.date)}</span>
          </button>
        ))}
      </div>

      {/* No per-project totals row here on purpose: the day breakdown already
          names each item's project, which is where the question "where did
          this come from?" actually gets asked. The server still returns
          `projects` — it's the record of which projects the sum was built
          from, and test/crossHours.test.js asserts on it. */}
      {/* Said only on a teammate's card, and said plainly: the walk covers
          the projects YOUR token lists, so a project they work in and you
          can't open is missing from this total — not skipped (nothing
          failed), never listed. */}
      {showCross && crossReady && !crossReady.self && (
        <p className="mt-2 text-xs text-ink-subtle">
          {t('hours.crossScopeNote', { count: crossReady.projectsScanned, name: personName ?? t('common.theyFallback') })}
        </p>
      )}
      {showCross && crossReady && crossReady.skipped.length > 0 && (
        <p className="mt-2 text-xs text-ink-subtle">
          {t('hours.crossSkippedNote', { list: crossReady.skipped.map((s) => s.name).join(', ') })}
        </p>
      )}

      {openDay && (
        <BreakdownPanel
          date={openDay}
          hours={openHours}
          org={org}
          project={project}
          entries={shown.breakdown[openDay] ?? []}
          onClose={() => setOpenDay(null)}
        />
      )}
    </section>
  );
}

