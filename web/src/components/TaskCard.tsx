import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, ExternalLink, Pencil, X } from 'lucide-react';
import type { Dashboard, Task } from '../lib/types';
import { StateChip } from './StateChip';
import { SprintMismatchChip } from './SprintMismatchChip';
import { ParentSprintRef } from './ParentSprintRef';
import { ProgressBar } from './ProgressBar';
import { formatHours } from '../lib/format';
import { useLang } from '../lib/i18n/useLang';
import { workItemUrl } from '../lib/adoLinks';
import { fetchTaskHours, logTaskHours, moveToParentIteration, setTaskProgress, setWorkItemState } from '../lib/api';
import { describeError, type ErrorDisplay } from '../lib/errorDisplay';
import { t } from '../lib/i18n';
import { queryKeyFor } from '../lib/useDashboard';
import { patchTaskInDashboard, patchWorkItemIterationInDashboard, patchWorkItemStateInDashboard } from '../lib/patchTask';
import { isSprintMismatch } from '../lib/sprintMismatch';
import { typeTheme } from '../lib/typeTheme';
import { AccentBar } from './ui/AccentBar';
import { Pill } from './ui/Pill';
import { IconButton } from './ui/IconButton';
import { PrimaryButton } from './ui/PrimaryButton';
import { InlineMessage } from './ui/InlineMessage';
import { Foreign } from './ui/Foreign';

type Mode = 'log' | 'pct';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Current completion as a whole percent of the estimate — the slider's
 * floor, since % completion isn't a way to walk work backwards, only
 * forward from wherever it already is. */
function pctOf(hours: { estimated: number; completed: number }): number {
  return hours.estimated > 0 ? Math.min(100, Math.round((hours.completed / hours.estimated) * 100)) : 0;
}

function TaskEditPanel({ task, onClose }: { task: Task; onClose: () => void }) {
  useLang((s) => s.lang); // subscribe so formatHours() below re-renders on language switch
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('log');
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorDisplay | null>(null);
  const [outcomeMessage, setOutcomeMessage] = useState<string | null>(null);

  // Re-read live hours on open rather than trusting the dashboard's cached
  // copy — that cache can be up to SYNC_INTERVAL_MS stale, and previewing a
  // percent conversion against a stale Original Estimate is exactly what
  // previously let a 3.0h preview save as 2.8h. Falls back to the cached
  // values if the fetch fails, so editing still works offline-ish.
  const liveHours = useQuery({
    queryKey: ['task-hours', task.id],
    queryFn: () => fetchTaskHours(task.id),
    staleTime: 0,
  });
  const hours = liveHours.data ?? task.hours;
  const pctDisabled = hours.estimated <= 0;
  const pctFloor = pctOf(hours);

  // Once live hours land, seed the % field with the real current value —
  // but only if the user hasn't already touched the slider themselves.
  useEffect(() => {
    if (mode === 'pct' && !touched && liveHours.data) {
      setValue(String(pctOf(liveHours.data)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveHours.data]);

  const parsed = Number(value);
  const hasValidInput = value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0;

  const preview = (() => {
    if (!hasValidInput) return null;
    const estimated = hours.estimated;
    const newCompleted = mode === 'log' ? hours.completed + parsed : estimated > 0 ? (parsed / 100) * estimated : null;
    if (newCompleted === null) return null;
    const newRemaining = estimated > 0 ? Math.max(0, estimated - newCompleted) : hours.remaining;
    const exceedsEstimate = estimated > 0 && newCompleted > estimated;
    const willClose = estimated > 0 && newCompleted >= estimated && !exceedsEstimate;
    return { newCompleted: round2(newCompleted), newRemaining: round2(newRemaining), exceedsEstimate, willClose };
  })();

  // In "%" mode, saving the exact value already on the task is a no-op —
  // block it rather than sending a redundant write.
  const unchanged = mode === 'pct' && hasValidInput && parsed === pctFloor;

  async function handleSubmit() {
    if (!hasValidInput || pending || unchanged) return;
    setPending(true);
    setError(null);
    try {
      const result = mode === 'log' ? await logTaskHours(task.id, parsed) : await setTaskProgress(task.id, parsed);
      // The self dashboard (queryKeyFor(null)) is the only writable one —
      // see StoryCard's handleStateChange for why.
      queryClient.setQueryData<Dashboard>(queryKeyFor(null), (prev) =>
        prev ? patchTaskInDashboard(prev, task.id, result.hours, result.newState ?? undefined) : prev
      );
      if (result.closed) {
        setOutcomeMessage(t('taskCard.outcomeClosed'));
        setTimeout(onClose, 1400);
      } else if (result.activated) {
        setOutcomeMessage(
          result.storyActivated
            ? t('taskCard.outcomeActivatedWithStory')
            : t('taskCard.outcomeActivated')
        );
        setTimeout(onClose, 1400);
      } else {
        onClose();
      }
    } catch (err) {
      setError(describeError(err, t('common.networkErrorTaskNotUpdated')));
    } finally {
      setPending(false);
    }
  }

  if (outcomeMessage) {
    return <InlineMessage tone="success" className="mt-1">{outcomeMessage}</InlineMessage>;
  }

  return (
    <div className="mt-1 space-y-2 rounded-card border border-border bg-surface-sunken p-2.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex gap-1 rounded-full bg-surface p-0.5 text-xs w-fit">
        <button
          type="button"
          onClick={() => {
            setMode('log');
            setValue('');
            setTouched(false);
          }}
          className={`focus-ring cursor-pointer rounded-full px-2.5 py-1 font-medium transition-colors ${mode === 'log' ? 'bg-accent/15 text-accent' : 'text-ink-muted'}`}
        >
          {t('taskCard.logHoursToday')}
        </button>
        <button
          type="button"
          onClick={() => {
            if (pctDisabled) return;
            setMode('pct');
            setValue(String(pctFloor));
            setTouched(false);
          }}
          disabled={pctDisabled}
          title={pctDisabled ? t('taskCard.noEstimateTitle') : undefined}
          className={`focus-ring cursor-pointer rounded-full px-2.5 py-1 font-medium transition-colors disabled:cursor-default disabled:opacity-40 ${mode === 'pct' ? 'bg-accent/15 text-accent' : 'text-ink-muted'}`}
        >
          {t('taskCard.setPercent')}
        </button>
      </div>

      {mode === 'pct' ? (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={pctFloor}
            max={100}
            step={1}
            value={hasValidInput ? parsed : pctFloor}
            onChange={(e) => {
              setValue(e.target.value);
              setTouched(true);
            }}
            disabled={liveHours.isLoading}
            className="focus-ring w-full accent-accent disabled:opacity-50"
          />
          <span className="w-10 shrink-0 text-end text-xs tabular-nums text-ink">
            {liveHours.isLoading ? '…' : `${hasValidInput ? parsed : pctFloor}%`}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={0.5}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t('taskCard.hoursPlaceholder')}
            className="focus-ring w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-ink focus-visible:border-accent"
          />
        </div>
      )}

      <PrimaryButton onClick={handleSubmit} disabled={!hasValidInput || pending || unchanged || (preview?.exceedsEstimate ?? false)} className="w-full">
        {pending ? t('common.saving') : t('common.save')}
      </PrimaryButton>

      {preview && (
        <p className={`text-xs tabular-nums ${preview.exceedsEstimate ? 'text-danger' : 'text-ink-muted'}`}>
          {t('taskCard.previewProgress', {
            completed: formatHours(preview.newCompleted),
            estimated: formatHours(hours.estimated),
            remaining: formatHours(preview.newRemaining),
          })}
          {preview.exceedsEstimate && t('taskCard.exceedsEstimate')}
          {preview.willClose && t('taskCard.willCloseAutomatically')}
        </p>
      )}

      {liveHours.isError && (
        <p className="text-xs text-ink-subtle">{t('taskCard.refreshError')}</p>
      )}

      {error && <InlineMessage tone="error" detail={error.detail}>{error.message}</InlineMessage>}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  org: string;
  project: string;
  /** Editing only applies to your own tasks — someone else's dashboard is
   * read-only, so the pencil is omitted entirely rather than shown and
   * rejected server-side. Defaults true so existing call sites (which are
   * all on your own dashboard today) don't need to opt in. */
  isSelf?: boolean;
  /** Selection checkbox — only meaningful for standalone (unparented) task
   * cards on the work items page. A task nested inside a story must not
   * opt into this: its hours are already counted in the parent story's
   * rollup, so selecting both would double-count. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** The enclosing story's own IterationPath — only set when this card is
   * rendered nested inside a StoryCard. Compared against the task's own
   * iterationPath to show the "still on another sprint" badge; standalone
   * cards (Recently Updated list, unparented blocks) pass nothing and never
   * show it, since there's no parent to compare against. */
  parentIterationPath?: string | null;
}

export function TaskCard({ task, org, project, isSelf = true, selectMode, selected, onToggleSelect, parentIterationPath }: TaskCardProps) {
  useLang((s) => s.lang); // subscribe so formatHours() below re-renders on language switch
  const [editing, setEditing] = useState(false);
  const [stateSaving, setStateSaving] = useState(false);
  const [iterationSaving, setIterationSaving] = useState(false);
  const queryClient = useQueryClient();
  // 006-linked-identity-aliases (FR-008): `task.editable` is false only for
  // an item still assigned to a LINKED identity, not the signed-in primary
  // one — a UI courtesy that stops offering a control the server would
  // refuse anyway (assertAssignedTo in ado/writeback.js is the real
  // enforcement). Defaults to true so an older cached payload with no such
  // field, or a teammate's payload, behaves exactly as before this field
  // existed.
  const canEdit = isSelf && (task.editable ?? true);
  // 007-all-assigned-types: not every type carries Completed Work (a Feature
  // doesn't), so the hours editor is only offered where an hours write can
  // land. A courtesy — the server refuses with TYPE_NO_HOURS regardless.
  // The state chip keeps using `canEdit`.
  const canEditHours = canEdit && (task.hoursEditable ?? true);
  const hasHours = task.hours.completed > 0 || task.hours.estimated > 0 || task.hours.remaining > 0;

  async function handleStateChange(newState: string) {
    setStateSaving(true);
    try {
      await setWorkItemState(task.id, newState);
      queryClient.setQueryData<Dashboard>(queryKeyFor(null), (prev) =>
        prev ? patchWorkItemStateInDashboard(prev, task.id, newState) : prev
      );
    } catch {
      // the picker itself has no room for an inline error message — a
      // failed change simply leaves the chip showing the old state, and
      // the next background sync reconciles either way.
    } finally {
      setStateSaving(false);
    }
  }

  async function handleMoveToParentSprint() {
    setIterationSaving(true);
    try {
      const result = await moveToParentIteration(task.id);
      queryClient.setQueryData<Dashboard>(queryKeyFor(null), (prev) =>
        prev ? patchWorkItemIterationInDashboard(prev, [task.id], result.iterationPath) : prev
      );
    } finally {
      setIterationSaving(false);
    }
  }

  const theme = typeTheme(task.type);

  return (
    <div
      className={`relative flex flex-col gap-2 rounded-card border ${theme.tint} ${
        selected ? `${theme.border} ring-2 ring-accent ring-offset-2 ring-offset-surface` : theme.border
      } ps-4 pe-3 py-2.5`}
      title={task.type}
    >
      <AccentBar tone={theme.accentTone} />
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {selectMode && (
            <input
              type="checkbox"
              checked={!!selected}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggleSelect?.()}
              className="focus-ring mt-1 h-4 w-4 shrink-0 cursor-pointer accent-accent"
              aria-label={t('taskCard.selectAriaLabel', { id: task.id })}
            />
          )}
          <a
            href={workItemUrl(org, project, task.id)}
            target="_blank"
            rel="noreferrer"
            className="focus-ring group flex min-w-0 items-start gap-1 text-sm font-medium text-ink transition-colors hover:text-accent"
          >
            <span className="shrink-0 tabular-nums text-ink-subtle">#{task.id}</span>
            {/* dir="auto" lives on the title span, not this flex container —
             * putting it on the container would flip #{id} and the title's
             * relative order for an Arabic title. */}
            <Foreign as="span" className="truncate text-start">{task.title}</Foreign>
            <ExternalLink size={12} className="mt-0.5 shrink-0 text-ink-subtle transition-colors group-hover:text-accent" />
          </a>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {task.blocked && (
            <Pill tone="danger">
              <Ban size={12} /> {t('taskCard.blockedPill')}
            </Pill>
          )}
          <StateChip
            state={task.state}
            type={task.type}
            editable={canEdit && !task.blocked}
            pending={stateSaving}
            onChange={handleStateChange}
          />
          {canEditHours && (
            <IconButton
              onClick={() => setEditing((v) => !v)}
              aria-label={editing ? t('taskCard.cancelEditAriaLabel') : t('taskCard.logHoursAriaLabel')}
              aria-expanded={editing}
              className="hover:text-accent"
            >
              {editing ? <X size={14} /> : <Pencil size={14} />}
            </IconButton>
          )}
        </div>
      </div>
      {task.description && (
        <Foreign as="p" className="line-clamp-2 text-start text-xs text-ink-subtle">
          {task.description.replace(/<[^>]+>/g, ' ')}
        </Foreign>
      )}

      <div className="flex items-center gap-3">
        <ProgressBar pct={task.progressPct} size="sm" tone={task.blocked ? 'warn' : 'accent'} />
        <span className="w-10 shrink-0 text-end text-xs font-medium tabular-nums text-ink-muted">
          {task.progressPct}%
        </span>
      </div>

      {(task.hoursEditable !== false || hasHours) && (
        <div className="flex items-center justify-between text-xs text-ink-muted tabular-nums">
          <span>{t('taskCard.hoursDone', { completed: formatHours(task.hours.completed), estimated: formatHours(task.hours.estimated) })}</span>
          <span>{t('taskCard.hoursLeft', { hours: formatHours(task.hours.remaining) })}</span>
        </div>
      )}

      {/* Cross-sprint-promoted card / past-owned search result: names the
       * parent it isn't shown under. Never both this AND the mismatch chip —
       * a promoted rendering carries parentRef but is never given
       * parentIterationPath (contracts/dashboard-payload.md, Client
       * obligations: "still on Sprint 78" is wrong on a card sitting inside
       * Sprint 78's own section). */}
      {task.parentRef && <ParentSprintRef parentRef={task.parentRef} org={org} project={project} />}

      {isSprintMismatch(task.iterationPath, parentIterationPath ?? null) && (
        <div className="text-xs">
          <SprintMismatchChip
            taskIterationPath={task.iterationPath}
            parentIterationPath={parentIterationPath ?? null}
            editable={canEdit}
            pending={iterationSaving}
            onMove={handleMoveToParentSprint}
          />
        </div>
      )}

      {canEditHours && editing && <TaskEditPanel task={task} onClose={() => setEditing(false)} />}
    </div>
  );
}


